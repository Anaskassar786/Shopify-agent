import { randomUUID } from "node:crypto";
import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import { WorkflowRunStartJob, WorkflowService } from "@profit/automation";
import { EngagementService } from "@profit/billing";
import type { JobPersistence, JobQueue } from "@profit/queue";
import { EngagementEventKind, FeatureFlag, WorkflowTriggerKind } from "@profit/types";
import type { Logger } from "@profit/logger";
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
import { requireFeature } from "../../middleware/feature-flags.middleware";
import type { JwtService } from "../auth/jwt.service";
import type { AuditService } from "../audit/audit.service";
import { passThroughAutomationError } from "./api-errors";

/**
 * /api/v1/workflows (M6 Automation Center): DAG CRUD + immutable versions +
 * lifecycle transitions + manual runs + run history/steps. Merchants manage
 * with automation:read / automation:manage (the M4 permission split). Writes
 * audit; manual runs fan out through the durable queue with a fresh
 * triggerEventId per click (idempotent by construction).
 */

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).nullable().optional(),
    definition: z.unknown(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    definition: z.unknown(),
  })
  .strict();

export function workflowsRouter(deps: {
  db: ProfitDb;
  jwt: JwtService;
  audit: AuditService;
  queue: JobQueue;
  persistence: JobPersistence;
  logger: Logger;
}): ExpressRouter {
  const router = Router();
  const workflows = new WorkflowService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("automation:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const rows = await workflows.list(req.appAuth.storeId);
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/", requireFeature(deps.db, FeatureFlag.AutomationDisabled), requirePermission("automation:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = createSchema.parse(req.body);
      const created = await workflows.create(req.appAuth.storeId, {
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        definition: body.definition,
        createdByUserId: req.appAuth.userId,
      });
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "workflow.created",
        entityType: "workflow",
        entityId: created.workflow.id,
        result: "SUCCESS",
        metadata: { name: body.name },
      });
      res.status(201).json(successEnvelope(getRequestContext(), created));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/:workflowId", requirePermission("automation:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const workflowId = req.params["workflowId"]!;
      const [workflow, versions] = await Promise.all([
        workflows.get(req.appAuth.storeId, workflowId),
        workflows.listVersions(req.appAuth.storeId, workflowId),
      ]);
      if (workflow === null) throw new NotFoundError("workflow", workflowId);
      const definition = workflow.activeVersionId !== null
        ? await workflows.getActiveDefinition(req.appAuth.storeId, workflowId)
        : null;
      res.status(200).json(successEnvelope(getRequestContext(), { workflow, versions, activeDefinition: definition }));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.put("/:workflowId", requireFeature(deps.db, FeatureFlag.AutomationDisabled), requirePermission("automation:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const workflowId = req.params["workflowId"]!;
      const body = updateSchema.parse(req.body);
      if (body.definition !== undefined) {
        const saved = await workflows.saveNewVersion(req.appAuth.storeId, workflowId, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          definition: body.definition,
          createdByUserId: req.appAuth.userId,
        });
        deps.audit.recordDetached({
          storeId: req.appAuth.storeId,
          userId: req.appAuth.userId,
          action: "workflow.version_saved",
          entityType: "workflow",
          entityId: workflowId,
          result: "SUCCESS",
          metadata: { version: saved.version.version },
        });
        res.status(200).json(successEnvelope(getRequestContext(), saved));
        return;
      }
      // Metadata-only edit (rename/description) — no new version.
      if (body.name === undefined && body.description === undefined) {
        throw new ValidationError("nothing to update");
      }
      const existing = await workflows.get(req.appAuth.storeId, workflowId);
      if (existing === null) throw new NotFoundError("workflow", workflowId);
      const savedMeta = await workflows.saveMetadata(req.appAuth.storeId, workflowId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      });
      res.status(200).json(successEnvelope(getRequestContext(), { workflow: savedMeta }));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  /** Activate a saved version (defaults to the newest). arms the schedule. */
  router.post("/:workflowId/activate", requireFeature(deps.db, FeatureFlag.AutomationDisabled), requirePermission("automation:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const workflowId = req.params["workflowId"]!;
      let versionId = typeof req.query["versionId"] === "string" ? req.query["versionId"] : null;
      if (versionId === null) {
        const versions = await workflows.listVersions(req.appAuth.storeId, workflowId);
        const latest = [...versions].sort((a, b) => b.version - a.version)[0];
        if (latest === undefined) throw new ValidationError("workflow has no saved version to activate");
        versionId = latest.id;
      }
      const updated = await workflows.activate(req.appAuth.storeId, workflowId, versionId);
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "workflow.activated",
        entityType: "workflow",
        entityId: workflowId,
        result: "SUCCESS",
        metadata: { versionId },
      });
      // M5 growth milestone (deduped): first workflow going live.
      try {
        await new EngagementService(deps.db).emit({
          storeId: req.appAuth.storeId,
          kind: EngagementEventKind.FirstWorkflowActivated,
        });
      } catch (error) {
        deps.logger.warn({ err: error, storeId: req.appAuth.storeId }, "engagement.first_workflow_activated.failed");
      }
      res.status(200).json(successEnvelope(getRequestContext(), updated));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/:workflowId/pause", requireFeature(deps.db, FeatureFlag.AutomationDisabled), requirePermission("automation:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const workflowId = req.params["workflowId"]!;
      const updated = await workflows.pause(req.appAuth.storeId, workflowId);
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "workflow.paused",
        entityType: "workflow",
        entityId: workflowId,
        result: "SUCCESS",
        metadata: {},
      });
      res.status(200).json(successEnvelope(getRequestContext(), updated));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/:workflowId/archive", requireFeature(deps.db, FeatureFlag.AutomationDisabled), requirePermission("automation:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const workflowId = req.params["workflowId"]!;
      const updated = await workflows.archive(req.appAuth.storeId, workflowId);
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "workflow.archived",
        entityType: "workflow",
        entityId: workflowId,
        result: "SUCCESS",
        metadata: {},
      });
      res.status(200).json(successEnvelope(getRequestContext(), updated));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  /** Manual run: fresh triggerEventId per click → unique run row per deliberate click. */
  router.post("/:workflowId/run", requireFeature(deps.db, FeatureFlag.AutomationDisabled), requirePermission("automation:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const workflowId = req.params["workflowId"]!;
      const workflow = await workflows.get(req.appAuth.storeId, workflowId);
      if (workflow === null) throw new NotFoundError("workflow", workflowId);
      const triggerEventId = `manual:${randomUUID()}`;
      await deps.persistence.enqueuePersistent(
        deps.queue,
        WorkflowRunStartJob,
        {
          storeId: req.appAuth.storeId,
          workflowId,
          triggerKind: WorkflowTriggerKind.Manual,
          triggerEventId,
        },
        { jobId: `wf-manual:${workflowId}:${triggerEventId}` },
      );
      res.status(202).json(successEnvelope(getRequestContext(), { accepted: true, triggerEventId }));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/:workflowId/runs", requirePermission("automation:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
      const result = await workflows.listRuns(req.appAuth.storeId, req.params["workflowId"]!, page, pageSize);
      res.status(200).json(successEnvelope(getRequestContext(), result));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/:workflowId/runs/:runId/steps", requirePermission("automation:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const storeId = req.appAuth.storeId;
      const workflowId = req.params["workflowId"]!;
      const runId = req.params["runId"]!;
      const [run, steps] = await Promise.all([
        workflows.getRun(storeId, workflowId, runId),
        workflows.listRunSteps(storeId, workflowId, runId),
      ]);
      if (run === null || steps === null) throw new NotFoundError("workflow run", runId);
      res.status(200).json(successEnvelope(getRequestContext(), { run, steps }));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  return router;
}
