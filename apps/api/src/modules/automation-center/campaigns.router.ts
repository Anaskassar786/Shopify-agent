import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import type { JobPersistence, JobQueue } from "@profit/queue";
import { CampaignDispatchJob, CampaignService, type VariantPayload } from "@profit/automation";
import type { Logger } from "@profit/logger";
import { CampaignAudience, CampaignVariant, MessageChannel } from "@profit/types";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import { parsePageParams } from "../../lib/http/pagination";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";
import type { AuditService } from "../audit/audit.service";
import { passThroughAutomationError } from "./api-errors";

/**
 * /api/v1/campaigns (M6 Campaigns): templates, campaign CRUD + lifecycle,
 * audience preview materialization (dispatch), live stats, A/B winner, and
 * the merchant suppression list. Sending is worker-owned; the API only
 * transitions state and enqueues the durable dispatch job (idempotent by
 * campaign id, so "send now" + the tick can race safely).
 */

const channelEnum = z.enum(Object.values(MessageChannel) as [MessageChannel, ...MessageChannel[]]);

const variantSchema = z
  .object({
    templateId: z.string().uuid().optional(),
    subject: z.string().max(200).optional(),
    bodyText: z.string().min(1).max(5_000),
    bodyHtml: z.string().max(20_000).optional(),
  })
  .strict();

const templateCreateSchema = z
  .object({
    name: z.string().min(1).max(140),
    channel: channelEnum,
    subject: z.string().max(200).nullable().optional(),
    bodyText: z.string().min(1).max(5_000),
    bodyHtml: z.string().max(20_000).nullable().optional(),
  })
  .strict();

const campaignCreateSchema = z
  .object({
    name: z.string().min(1).max(140),
    channel: channelEnum,
    audience: z.enum(Object.values(CampaignAudience) as [CampaignAudience, ...CampaignAudience[]]),
    variantA: variantSchema,
    variantB: variantSchema.optional(),
    splitBPercent: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const scheduleSchema = z
  .object({
    /** ISO date; omit or past date = send on the next tick (dispatch job). */
    scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const winnerSchema = z
  .object({ variant: z.enum([CampaignVariant.A, CampaignVariant.B]) })
  .strict();

/** exactOptionalPropertyTypes bridge: zod marks optionals `| undefined`; the domain port wants them absent. */
function variantOf(parsed: z.infer<typeof variantSchema>): VariantPayload {
  return {
    ...(parsed.templateId !== undefined ? { templateId: parsed.templateId } : {}),
    ...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
    bodyText: parsed.bodyText,
    ...(parsed.bodyHtml !== undefined ? { bodyHtml: parsed.bodyHtml } : {}),
  };
}

export function campaignsRouter(deps: {
  db: ProfitDb;
  jwt: JwtService;
  audit: AuditService;
  queue: JobQueue;
  persistence: JobPersistence;
  logger: Logger;
}): ExpressRouter {
  const router = Router();
  const campaigns = new CampaignService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  /* ─── templates ────────────────────────────────────────────────── */

  router.get("/templates", requirePermission("campaigns:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const channel = typeof req.query["channel"] === "string" ? req.query["channel"] : undefined;
      if (channel !== undefined && channel !== MessageChannel.Email && channel !== MessageChannel.Sms) {
        throw new ValidationError("channel must be EMAIL or SMS");
      }
      const rows = await campaigns.listTemplates(req.appAuth.storeId, channel);
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/templates", requirePermission("campaigns:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = templateCreateSchema.parse(req.body);
      const row = await campaigns.createTemplate(req.appAuth.storeId, {
        name: body.name,
        channel: body.channel,
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        bodyText: body.bodyText,
        ...(body.bodyHtml !== undefined ? { bodyHtml: body.bodyHtml } : {}),
      });
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "campaign.template_created",
        entityType: "message_template",
        entityId: row.id,
        result: "SUCCESS",
        metadata: { name: body.name, channel: body.channel },
      });
      res.status(201).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.put("/templates/:templateId", requirePermission("campaigns:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = templateCreateSchema.partial().omit({ channel: true }).parse(req.body);
      const row = await campaigns.updateTemplate(req.appAuth.storeId, req.params["templateId"]!, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.bodyText !== undefined ? { bodyText: body.bodyText } : {}),
        ...(body.bodyHtml !== undefined ? { bodyHtml: body.bodyHtml } : {}),
      });
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.delete("/templates/:templateId", requirePermission("campaigns:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      await campaigns.deleteTemplate(req.appAuth.storeId, req.params["templateId"]!);
      res.status(200).json(successEnvelope(getRequestContext(), { deleted: true }));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  /* ─── campaigns ────────────────────────────────────────────────── */

  router.get("/", requirePermission("campaigns:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const rows = await campaigns.listCampaigns(req.appAuth.storeId);
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/", requirePermission("campaigns:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = campaignCreateSchema.parse(req.body);
      const row = await campaigns.createCampaign(req.appAuth.storeId, {
        name: body.name,
        channel: body.channel,
        audience: body.audience,
        variantA: variantOf(body.variantA),
        ...(body.variantB !== undefined ? { variantB: variantOf(body.variantB) } : {}),
        ...(body.splitBPercent !== undefined ? { splitBPercent: body.splitBPercent } : {}),
        createdByUserId: req.appAuth.userId,
      });
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "campaign.created",
        entityType: "campaign",
        entityId: row.id,
        result: "SUCCESS",
        metadata: { name: body.name, channel: body.channel, audience: body.audience },
      });
      res.status(201).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  /* ─── suppressions (merchant transparency) — BEFORE /:campaignId so
         "suppressions" is never captured as a campaign id. ────────── */

  router.get("/suppressions/:channel", requirePermission("campaigns:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const channel = req.params["channel"]!;
      if (channel !== MessageChannel.Email && channel !== MessageChannel.Sms) {
        throw new ValidationError("channel must be EMAIL or SMS");
      }
      const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
      const result = await campaigns.listSuppressions(req.appAuth.storeId, channel, page, pageSize);
      res.status(200).json(successEnvelope(getRequestContext(), result));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/:campaignId", requirePermission("campaigns:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const row = await campaigns.getCampaign(req.appAuth.storeId, req.params["campaignId"]!);
      if (row === null) throw new NotFoundError("campaign", req.params["campaignId"]);
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/:campaignId/schedule", requirePermission("campaigns:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = scheduleSchema.parse(req.body);
      const scheduledAt = body.scheduledAt !== undefined && body.scheduledAt !== null
        ? new Date(body.scheduledAt)
        : null;
      if (scheduledAt !== null && Number.isNaN(scheduledAt.getTime())) {
        throw new ValidationError("scheduledAt must be a valid ISO datetime");
      }
      const row = await campaigns.scheduleCampaign(req.appAuth.storeId, req.params["campaignId"]!, scheduledAt);
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "campaign.scheduled",
        entityType: "campaign",
        entityId: row.id,
        result: "SUCCESS",
        metadata: { scheduledAt: row.scheduledAt?.toISOString() ?? null },
      });
      // "Send now" (past/now): enqueue the dispatch immediately instead of
      // waiting up to one tick interval. The jobId dedupes against the tick.
      if (row.scheduledAt !== null && row.scheduledAt.getTime() <= Date.now()) {
        await deps.persistence.enqueuePersistent(
          deps.queue,
          CampaignDispatchJob,
          { storeId: req.appAuth.storeId, campaignId: row.id },
          { jobId: `campaign-dispatch:${row.id}` },
        );
      }
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/:campaignId/cancel", requirePermission("campaigns:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const row = await campaigns.cancelCampaign(req.appAuth.storeId, req.params["campaignId"]!);
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/:campaignId/stats", requirePermission("campaigns:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const stats = await campaigns.getStats(req.appAuth.storeId, req.params["campaignId"]!);
      res.status(200).json(successEnvelope(getRequestContext(), stats));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/:campaignId/winner", requirePermission("campaigns:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = winnerSchema.parse(req.body);
      const row = await campaigns.declareWinner(req.appAuth.storeId, req.params["campaignId"]!, body.variant);
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "campaign.winner_declared",
        entityType: "campaign",
        entityId: row.id,
        result: "SUCCESS",
        metadata: { winner: body.variant },
      });
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  return router;
}
