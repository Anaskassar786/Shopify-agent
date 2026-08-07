import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import type { JobPersistence, JobQueue } from "@profit/queue";
import { ExportGenerateJob, ExportService } from "@profit/automation";
import type { Logger } from "@profit/logger";
import { ExportFormat, ExportKind } from "@profit/types";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { ForbiddenError, NotFoundError } from "../../lib/errors";
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
 * /api/v1/exports (M6): report requests → durable job → downloadable file.
 * Generation is worker-owned (bytea bytes + expiry sweep); the API enqueues
 * with a deterministic jobId so repeated "request" clicks never double-build.
 * Download streams real bytes with truthful content headers (never a stub).
 */

const requestSchema = z
  .object({
    kind: z.enum(Object.values(ExportKind) as [ExportKind, ...ExportKind[]]),
    format: z.enum(Object.values(ExportFormat) as [ExportFormat, ...ExportFormat[]]),
    params: z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function exportsRouter(deps: {
  db: ProfitDb;
  jwt: JwtService;
  audit: AuditService;
  queue: JobQueue;
  persistence: JobPersistence;
  logger: Logger;
}): ExpressRouter {
  const router = Router();
  const exportsSvc = new ExportService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("exports:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
      const result = await exportsSvc.list(req.appAuth.storeId, page, pageSize);
      res.status(200).json(successEnvelope(getRequestContext(), result));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/", requirePermission("exports:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = requestSchema.parse(req.body);
      const row = await exportsSvc.request(req.appAuth.storeId, {
        kind: body.kind,
        format: body.format,
        ...(body.params !== undefined ? { params: body.params } : {}),
        requestedByUserId: req.appAuth.userId,
      });
      await deps.persistence.enqueuePersistent(
        deps.queue,
        ExportGenerateJob,
        { storeId: req.appAuth.storeId, exportId: row.id },
        { jobId: `export-generate:${row.id}` },
      );
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "export.requested",
        entityType: "export",
        entityId: row.id,
        result: "SUCCESS",
        metadata: { kind: body.kind, format: body.format },
      });
      res.status(201).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/:exportId", requirePermission("exports:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const row = await exportsSvc.getExport(req.appAuth.storeId, req.params["exportId"]!);
      if (row === null) throw new NotFoundError("export", req.params["exportId"]);
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  /** Binary download — the only route answering non-JSON by design. */
  router.get("/:exportId/download", requirePermission("exports:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const file = await exportsSvc.loadFile(req.appAuth.storeId, req.params["exportId"]!);
      res.status(200);
      res.setHeader("content-type", file.mime);
      res.setHeader(
        "content-disposition",
        `attachment; filename="${file.fileName.replaceAll('"', "")}"`,
      );
      res.setHeader("cache-control", "no-store");
      res.send(file.data);
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  return router;
}
