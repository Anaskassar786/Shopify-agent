import { Router, type Router as ExpressRouter } from "express";
import type { NextFunction, Request, Response } from "express";
import { and, desc, eq, gte, sql, backgroundJobs, failedJobs, platformAdminActions, stores, supportTickets } from "@profit/db";
import { featureFlagsFor, mergeFeatureOverrides } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { AccessOverrideKind, JobStatus, PlatformAdminAction, SupportTicketStatus } from "@profit/types";
import { AccessOverrideService, BillingService, GrowthAnalyticsService } from "@profit/billing";
import { SupportNotifyJob, SupportService } from "@profit/automation";
import type { JobPersistence, JobQueue } from "@profit/queue";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { AuthenticationError, NotFoundError, ValidationError } from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import { parsePageParams } from "../../lib/http/pagination";
import { requirePlatformAdmin } from "../../middleware/platform-admin.middleware";
import type { AuditService } from "../audit/audit.service";
import { adminPayloadHash, mintAdminSession, verifyAdminSession } from "./admin-session";
import { AccessReviewService } from "./access-review.service";
import { passThroughAutomationError } from "../automation-center/api-errors";
import { OpsFlagsService } from "../ops/ops-flags.service";

/**
 * /api/v1/admin (M5 READ panel + M6 WRITE surface, P4/P12).
 *
 * Trust model (ADR 22): the env key alone authorizes READS. WRITES require
 * a step-up session (POST /session with key + operator identity + reason →
 * 15-min HMAC token) presented as `X-Admin-Session`. Every write is then
 * recorded in platform_admin_actions {operator, action, target, payloadHash,
 * ip} — tamper-evident operator provenance, cross-tenant by deliberate
 * design. Sessions are stateless (multi-replica safe): HMAC-signed expiry,
 * no DB lookup on the write path.
 */

const sessionSchema = z
  .object({ operatorId: z.string().min(1).max(200), reason: z.string().min(1).max(500) })
  .strict();

const trialExtendSchema = z
  .object({
    additionalDays: z.number().int().min(1).max(90),
    reason: z.string().min(1).max(500),
  })
  .strict();

const overrideGrantSchema = z
  .object({
    kind: z.enum(Object.values(AccessOverrideKind) as [AccessOverrideKind, ...AccessOverrideKind[]]),
    accessUntil: z.string().datetime({ offset: true }),
    reason: z.string().min(1).max(500),
  })
  .strict();

const overrideRevokeSchema = z
  .object({ reason: z.string().min(1).max(500) })
  .strict();

const ticketReplySchema = z
  .object({ body: z.string().min(1).max(10_000) })
  .strict();

/** Launch readiness (ADR 37): maintenance toggle — the only platform-scope write. */
const maintenanceSchema = z
  .object({
    enabled: z.boolean(),
    message: z.string().max(500).nullable().optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();

/** Launch readiness (ADR 37): closed taxonomy — unknown keys are 400s, not silent drops. */
const featureFlagsPatchSchema = z
  .object({
    flags: z
      .object({
        aiDisabled: z.boolean().optional(),
        automationDisabled: z.boolean().optional(),
      })
      .strict()
      .refine((value) => Object.values(value).some((flag) => flag !== undefined), "at least one flag key is required"),
    reason: z.string().min(1).max(500),
  })
  .strict();

export function adminRouter(deps: {
  db: ProfitDb;
  platformAdminKey: string | undefined;
  audit: AuditService;
  queue?: JobQueue;
  persistence?: JobPersistence;
}): ExpressRouter {
  const router = Router();
  const growth = new GrowthAnalyticsService(deps.db);
  const billing = new BillingService(deps.db);
  const overrides = new AccessOverrideService(deps.db);
  const support = new SupportService(deps.db);
  const accessReview = new AccessReviewService(deps.db);
  const opsFlags = new OpsFlagsService(deps.db);

  router.use(requirePlatformAdmin({ platformAdminKey: deps.platformAdminKey, audit: deps.audit }));

  /**
   * Step-up gate for the WRITE surface. Session tokens ride X-Admin-Session;
   * the operator id they carry is stamped on every action row — an unprovenanced
   * write is refused outright (401), never silently attributed.
   */
  function requireAdminSession(req: Request, _res: Response, next: NextFunction): void {
    const key = deps.platformAdminKey;
    const token = req.header("x-admin-session");
    if (key === undefined || token === undefined) {
      next(new AuthenticationError("admin write requires an X-Admin-Session step-up token"));
      return;
    }
    const operatorId = verifyAdminSession(key, token);
    if (operatorId === null) {
      next(new AuthenticationError("admin session invalid or expired — POST /api/v1/admin/session first"));
      return;
    }
    req.adminOperatorId = operatorId;
    next();
  }

  async function recordAction(
    req: Request,
    input: {
      action: (typeof PlatformAdminAction)[keyof typeof PlatformAdminAction];
      storeId: string | null;
      targetType: string;
      targetId: string;
      payload: unknown;
    },
  ): Promise<void> {
    await deps.db.insert(platformAdminActions).values({
      storeId: input.storeId,
      operatorId: req.adminOperatorId ?? "session-open",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      payloadHash: adminPayloadHash(input.payload),
      ip: req.ip ?? null,
    });
  }

  /* ─── session ──────────────────────────────────────────────────── */

  router.post("/session", async (req, res, next) => {
    try {
      const key = deps.platformAdminKey;
      if (key === undefined) throw new AuthenticationError("admin key not configured");
      const body = sessionSchema.parse(req.body);
      const session = mintAdminSession(key, body.operatorId);
      req.adminOperatorId = body.operatorId;
      await recordAction(req, {
        action: PlatformAdminAction.OpenSession,
        storeId: null,
        targetType: "operator",
        targetId: body.operatorId,
        payload: { reason: body.reason },
      });
      res.status(201).json(
        successEnvelope(getRequestContext(), {
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          operatorId: body.operatorId,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  /* ─── reads (M5 surface) ───────────────────────────────────────── */

  router.get("/overview", async (_req, res, next) => {
    try {
      const [dashboard, funnel] = await Promise.all([growth.ownerDashboard(), growth.activationFunnel()]);
      res.status(200).json(successEnvelope(getRequestContext(), { dashboard, funnel }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/merchants", async (req, res, next) => {
    try {
      const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
      const rows = await growth.merchants(pageSize, (page - 1) * pageSize);
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(error);
    }
  });

  router.get("/ai-usage", async (_req, res, next) => {
    try {
      const rows = await growth.aiUsageByStore();
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(error);
    }
  });

  /* ─── M6: support inbox + merchant writes (step-up required) ───── */

  /** Cross-tenant ticket inbox — operator read (no step-up: read-only). */
  router.get("/tickets", async (req, res, next) => {
    try {
      const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
      const attentionOnly = req.query["attention"] === "1" || req.query["attention"] === "true";
      const statusQuery = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
      const statuses = Object.values(SupportTicketStatus) as readonly string[];
      if (statusQuery !== undefined && !statuses.includes(statusQuery)) {
        throw new ValidationError(`status must be one of ${statuses.join(", ")}`);
      }
      const result = await support.listForOperators({
        attentionOnly,
        ...(statusQuery !== undefined ? { status: statusQuery as (typeof SupportTicketStatus)[keyof typeof SupportTicketStatus] } : {}),
        page,
        pageSize,
      });
      res.status(200).json(successEnvelope(getRequestContext(), result));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/tickets/:ticketId", async (req, res, next) => {
    try {
      const row = await support.getForOperator(req.params["ticketId"]!);
      if (row === null) throw new NotFoundError("support ticket", req.params["ticketId"]);
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  /** TicketRow strips storeId for tenant hygiene; the admin surface re-reads it where cross-tenant truth is required. */
  async function ticketStoreId(ticketId: string): Promise<string> {
    const rows = await deps.db
      .select({ storeId: supportTickets.storeId })
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new NotFoundError("support ticket", ticketId);
    return row.storeId;
  }

  /** Write: reply in-thread as the operator → merchant notified via durable job. */
  router.post("/tickets/:ticketId/reply", requireAdminSession, async (req, res, next) => {
    try {
      const ticketId = req.params["ticketId"]!;
      const body = ticketReplySchema.parse(req.body);
      const outcome = await support.replyAsOperator(ticketId, req.adminOperatorId!, body.body);
      const storeId = await ticketStoreId(ticketId);
      if (deps.queue !== undefined && deps.persistence !== undefined) {
        await deps.persistence.enqueuePersistent(
          deps.queue,
          SupportNotifyJob,
          { storeId, ticketId, messageId: outcome.messageId },
          { jobId: `support-notify:${outcome.messageId}` },
        );
      }
      await recordAction(req, {
        action: PlatformAdminAction.ReplyTicket,
        storeId,
        targetType: "support_ticket",
        targetId: ticketId,
        payload: body,
      });
      res.status(201).json(successEnvelope(getRequestContext(), outcome));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  for (const [verb, action] of [
    ["resolve", PlatformAdminAction.ResolveTicket],
    ["close", PlatformAdminAction.CloseTicket],
  ] as const) {
    router.post(`/tickets/:ticketId/${verb}`, requireAdminSession, async (req, res, next) => {
      try {
        const ticketId = req.params["ticketId"]!;
        const ticket = await support.operatorTransition(
          ticketId,
          verb === "resolve" ? SupportTicketStatus.Resolved : SupportTicketStatus.Closed,
        );
        await recordAction(req, {
          action,
          storeId: await ticketStoreId(ticketId),
          targetType: "support_ticket",
          targetId: ticketId,
          payload: { verb },
        });
        res.status(200).json(successEnvelope(getRequestContext(), ticket));
      } catch (error) {
        next(passThroughAutomationError(error));
      }
    });
  }

  /** Write: extend a merchant's trial window (TRIALING stacks; EXPIRED reactivates). */
  router.post("/merchants/:storeId/trial-extension", requireAdminSession, async (req, res, next) => {
    try {
      const storeId = req.params["storeId"]!;
      const body = trialExtendSchema.parse(req.body);
      const subscription = await billing.extendTrial(storeId, body.additionalDays, new Date(), {
        operatorId: req.adminOperatorId!,
        reason: body.reason,
      });
      await recordAction(req, {
        action: PlatformAdminAction.ExtendTrial,
        storeId,
        targetType: "subscription",
        targetId: subscription.id,
        payload: body,
      });
      res.status(200).json(successEnvelope(getRequestContext(), subscription));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  /** Write: grant a time-boxed support access override (status-gate bypass). */
  router.post("/merchants/:storeId/access-overrides", requireAdminSession, async (req, res, next) => {
    try {
      const storeId = req.params["storeId"]!;
      const body = overrideGrantSchema.parse(req.body);
      const row = await overrides.grant(storeId, {
        kind: body.kind,
        accessUntil: new Date(body.accessUntil),
        reason: body.reason,
        grantedBy: req.adminOperatorId!,
      });
      await recordAction(req, {
        action: PlatformAdminAction.GrantAccessOverride,
        storeId,
        targetType: "access_override",
        targetId: row.id,
        payload: body,
      });
      res.status(201).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/merchants/:storeId/access-overrides/:overrideId/revoke", requireAdminSession, async (req, res, next) => {
    try {
      const body = overrideRevokeSchema.parse(req.body);
      const row = await overrides.revoke(req.params["storeId"]!, req.params["overrideId"]!, {
        revokedBy: req.adminOperatorId!,
        reason: body.reason,
      });
      await recordAction(req, {
        action: PlatformAdminAction.RevokeAccessOverride,
        storeId: req.params["storeId"]!,
        targetType: "access_override",
        targetId: row.id,
        payload: body,
      });
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/merchants/:storeId/access-overrides", async (req, res, next) => {
    try {
      const rows = await overrides.listForStore(req.params["storeId"]!);
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  /** Operator action log (the admin surface's own audit trail, paged). */
  router.get("/actions", async (req, res, next) => {
    try {
      const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
      const rows = await deps.db
        .select()
        .from(platformAdminActions)
        .orderBy(desc(platformAdminActions.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(error);
    }
  });

  /* ─── M7: SOC-2-lite access review (read-only; key gate suffices) ── */

  /** Global operator-session ledger: who held admin WRITE authority, when, from where. */
  router.get("/access-review/sessions", async (_req, res, next) => {
    try {
      const rows = await accessReview.operatorSessions();
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(error);
    }
  });

  /** Per-store access review: members × roles × permissions, live overrides, recent operator writes. */
  router.get("/access-review", async (req, res, next) => {
    try {
      const storeId = req.query["storeId"];
      if (typeof storeId !== "string" || storeId === "") {
        throw new ValidationError("storeId query parameter is required");
      }
      const review = await accessReview.reviewStore(storeId);
      if (review === null) throw new NotFoundError("store", storeId);
      res.status(200).json(successEnvelope(getRequestContext(), review));
    } catch (error) {
      next(error);
    }
  });

  /* ─── launch readiness: ops control plane (ADR 37) ─────────────── */

  /** Current platform ops flags (maintenance state + provenance). */
  router.get("/ops/flags", async (_req, res, next) => {
    try {
      const maintenance = await opsFlags.getMaintenance();
      res.status(200).json(successEnvelope(getRequestContext(), { maintenance }));
    } catch (error) {
      next(error);
    }
  });

  /** Write: enable/disable maintenance mode (step-up). Engages on the NEXT merchant request. */
  router.patch("/ops/maintenance", requireAdminSession, async (req, res, next) => {
    try {
      const body = maintenanceSchema.safeParse(req.body);
      if (!body.success) throw ValidationError.fromZod(body.error.issues);
      const state = await opsFlags.setMaintenance({
        enabled: body.data.enabled,
        message: body.data.message ?? null,
        setBy: req.adminOperatorId!,
      });
      await recordAction(req, {
        action: PlatformAdminAction.SetMaintenanceMode,
        storeId: null,
        targetType: "platform_flags",
        targetId: "maintenance",
        payload: body.data,
      });
      res.status(200).json(successEnvelope(getRequestContext(), { maintenance: state }));
    } catch (error) {
      next(error);
    }
  });

  /** Per-store feature flags (current taxonomy values, others default off). */
  router.get("/merchants/:storeId/feature-flags", async (req, res, next) => {
    try {
      const storeId = req.params["storeId"]!;
      const exists = await deps.db.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).limit(1);
      if (exists[0] === undefined) throw new NotFoundError("store", storeId);
      const flags = await featureFlagsFor(deps.db, storeId);
      res.status(200).json(successEnvelope(getRequestContext(), { storeId, flags }));
    } catch (error) {
      next(error);
    }
  });

  /** Write: merge per-merchant feature flags (step-up; last-write-wins per key). */
  router.patch("/merchants/:storeId/feature-flags", requireAdminSession, async (req, res, next) => {
    try {
      const storeId = req.params["storeId"]!;
      const body = featureFlagsPatchSchema.safeParse(req.body);
      if (!body.success) throw ValidationError.fromZod(body.error.issues);
      const exists = await deps.db.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).limit(1);
      if (exists[0] === undefined) throw new NotFoundError("store", storeId);
      const flags = await mergeFeatureOverrides(deps.db, storeId, body.data.flags);
      await recordAction(req, {
        action: PlatformAdminAction.SetFeatureFlags,
        storeId,
        targetType: "store_settings",
        targetId: storeId,
        payload: { flags: body.data.flags, reason: body.data.reason },
      });
      res.status(200).json(successEnvelope(getRequestContext(), { storeId, flags }));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Job-queue ops view (PRD Part-5: pending · running · completed · failed ·
   * retries · DLQ). Cross-tenant by deliberate admin design (same trust class
   * as growth analytics). Reads the durable background_jobs mirror, so the
   * view is correct even when Redis is down or queues are paused.
   */
  router.get("/ops/jobs", async (_req, res, next) => {
    try {
      const dayAgo = new Date(Date.now() - 86_400_000);
      const [byStatusRows, byQueueRows, failedToday, deadLetteredRows, latestRows] = await Promise.all([
        deps.db
          .select({ status: backgroundJobs.status, count: sql<number>`count(*)::int` })
          .from(backgroundJobs)
          .groupBy(backgroundJobs.status),
        deps.db
          .select({
            queue: backgroundJobs.queue,
            queued: sql<number>`count(*) filter (where ${backgroundJobs.status} = ${JobStatus.Queued})::int`,
            running: sql<number>`count(*) filter (where ${backgroundJobs.status} = ${JobStatus.Running})::int`,
            failed: sql<number>`count(*) filter (where ${backgroundJobs.status} in (${JobStatus.Failed}, ${JobStatus.DeadLettered}))::int`,
            attempts: sql<number>`coalesce(sum(${backgroundJobs.attempts}), 0)::int`,
          })
          .from(backgroundJobs)
          .groupBy(backgroundJobs.queue),
        deps.db
          .select({ count: sql<number>`count(*)::int` })
          .from(backgroundJobs)
          .where(and(eq(backgroundJobs.status, JobStatus.Failed), gte(backgroundJobs.updatedAt, dayAgo))),
        deps.db.select({ count: sql<number>`count(*)::int` }).from(failedJobs),
        deps.db.select({ latest: sql<Date | null>`max(${backgroundJobs.updatedAt})` }).from(backgroundJobs),
      ]);

      const byStatus: Record<string, number> = Object.fromEntries(Object.values(JobStatus).map((status) => [status, 0]));
      for (const row of byStatusRows) byStatus[row.status] = row.count;

      res.status(200).json(
        successEnvelope(getRequestContext(), {
          byStatus,
          failedLast24h: failedToday[0]?.count ?? 0,
          deadLettered: deadLetteredRows[0]?.count ?? 0,
          byQueue: byQueueRows,
          latestActivityAt: latestRows[0]?.latest ?? null,
          sampledAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
