import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import type { JobPersistence, JobQueue } from "@profit/queue";
import {
  AiExecuteDiscountActionJob,
  AiExecuteEmailActionJob,
  AiRunJob,
  InvalidTransitionError,
  RecommendationConflictError,
  RecommendationNotFoundError,
  RecommendationService,
  listFiltersSchema,
  decisionInputSchema,
} from "@profit/ai";
import { z } from "zod";
import { BillingService, EngagementService } from "@profit/billing";
import {
  ActionType,
  AiRunTrigger,
  EngagementEventKind,
  Priority,
  RecommendationStatus,
  UsageMeter,
} from "@profit/types";
import { getRequestContext } from "../../lib/context/request-context";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { listMeta, successEnvelope } from "../../lib/http/envelope";
import { parsePageParams } from "../../lib/http/pagination";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";
import type { AuditService } from "../audit/audit.service";
import type { Logger } from "@profit/logger";
import { assertEntitled } from "../billing/entitlement.guard";

/**
 * /api/v1/recommendations (P3 human approval flow). The router is thin: list/
 * detail reads and approve/reject decisions delegate to the shared state
 * machine in @profit/ai; queue dispatch for executions happens here (the
 * composition layer owns transport).
 */

const listQuerySchema = z.object({
  status: z.nativeEnum(RecommendationStatus).optional(),
  priority: z.nativeEnum(Priority).optional(),
  type: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function mapTransitionError(error: unknown): unknown {
  if (error instanceof RecommendationNotFoundError) return new NotFoundError("Recommendation", "unknown");
  if (error instanceof InvalidTransitionError) return new ConflictError(error.message);
  if (error instanceof RecommendationConflictError) return new ConflictError(error.message);
  return error;
}

export function recommendationsRouter(deps: {
  db: ProfitDb;
  jwt: JwtService;
  queue: JobQueue;
  persistence: JobPersistence;
  audit: AuditService;
  logger: Logger;
}): ExpressRouter {
  const router = Router();
  const service = new RecommendationService(deps.db);
  // M5: the revenue-action gate + growth telemetry live beside the state machine.
  const billing = new BillingService(deps.db);
  const engagement = new EngagementService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("recommendations:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) throw ValidationError.fromZod(parsed.error.issues);
      const page = parsePageParams(req.query);
      const filters = listFiltersSchema.parse({
        status: parsed.data.status,
        type: parsed.data.type,
        priority: parsed.data.priority,
        page: page.page,
        pageSize: page.pageSize,
      });
      const result = await service.list(req.appAuth.storeId, filters);
      res.status(200).json(
        successEnvelope(getRequestContext(), result.rows, {
          meta: listMeta(page.page, page.pageSize, result.total),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", requirePermission("recommendations:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const detail = await service.detail(req.appAuth.storeId, String(req.params["id"]));
      if (detail === null) throw new NotFoundError("Recommendation", String(req.params["id"]));
      res.status(200).json(successEnvelope(getRequestContext(), detail));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/approve", requirePermission("recommendations:approve"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const id = String(req.params["id"]);
      // M5 gate: approving launches an execution unit (quota) under an active plan.
      await assertEntitled(billing, req.appAuth.storeId, UsageMeter.AutomationRuns);
      const { row, execution } = await service.approve(
        req.appAuth.storeId,
        id,
        req.appAuth.userId,
      );
      if (execution !== null) {
        const job =
          execution.actionType === ActionType.SendRecoveryEmail
            ? AiExecuteEmailActionJob
            : AiExecuteDiscountActionJob;
        await deps.persistence.enqueuePersistent(
          deps.queue,
          job,
          { storeId: req.appAuth.storeId, recommendationId: id, executionId: execution.executionId },
          { jobId: `aiexec:${execution.executionId}` },
        );
      }
      // ADVISORY approvals complete inline inside service.approve (EXECUTED).
      // Milestone telemetry must never break the approval path: a failed emit
      // leaves no row, so the NEXT approval naturally re-emits (self-heals).
      try {
        await engagement.emit({
          storeId: req.appAuth.storeId,
          kind: EngagementEventKind.FirstRecommendationApproved,
          userId: req.appAuth.userId,
        });
      } catch (error) {
        deps.logger.warn({ err: error }, "engagement.first_recommendation_approved.failed");
      }
      await deps.audit.record({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "recommendation.approved",
        entityType: "recommendation",
        entityId: id,
        result: "SUCCESS",
        metadata: { type: row.type, actionType: row.actionType },
      });
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(mapTransitionError(error));
    }
  });

  router.post("/:id/reject", requirePermission("recommendations:reject"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const id = String(req.params["id"]);
      const body = decisionInputSchema.safeParse(req.body ?? {});
      if (!body.success) throw ValidationError.fromZod(body.error.issues);
      const row = await service.reject(
        req.appAuth.storeId,
        id,
        req.appAuth.userId,
        body.data.reason,
      );
      await deps.audit.record({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "recommendation.rejected",
        entityType: "recommendation",
        entityId: id,
        result: "SUCCESS",
        metadata: { type: row.type, reason: body.data.reason ?? null },
      });
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(mapTransitionError(error));
    }
  });

  /**
   * Manual engine run (P10: scheduled + manual triggers). Per-minute bucket
   * jobId — double-clicking the button can never double-charge the provider.
   */
  router.post("/run", requirePermission("recommendations:approve"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      // M5 gate: a manual run plans paid model calls — subscription + quota first.
      await assertEntitled(billing, req.appAuth.storeId, UsageMeter.AiCalls);
      const minuteBucket = Math.floor(Date.now() / 60_000);
      const jobId = await deps.persistence.enqueuePersistent(
        deps.queue,
        AiRunJob,
        {
          storeId: req.appAuth.storeId,
          trigger: AiRunTrigger.Manual,
          requestedByUserId: req.appAuth.userId,
        },
        { jobId: `ai:manual:${req.appAuth.storeId}:${minuteBucket}` },
      );
      await deps.audit.record({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "ai.run.requested",
        entityType: "ai_run",
        entityId: jobId,
        result: "SUCCESS",
        metadata: { trigger: AiRunTrigger.Manual },
      });
      res.status(202).json(successEnvelope(getRequestContext(), { jobId }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
