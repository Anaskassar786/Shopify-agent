import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import type { ProfitDb } from "@profit/db";
import type { AiProvider, EmailSender } from "@profit/ai";
import type { Logger } from "@profit/logger";
import {
  ReportNotFoundError,
  ReportService,
  closedPeriodFor,
} from "@profit/reporting";
import { ReportKind } from "@profit/types";
import { getRequestContext } from "../../lib/context/request-context";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/reports — the M8 enterprise reporting surface (ADR 34, RBAC
 * `reports:read`/`reports:manage` per ADR 35). Manual generation targets the
 * CURRENT closed period; PDF download streams the stored bytes.
 */

const generateBodySchema = z
  .object({ kind: z.nativeEnum(ReportKind) })
  .strict();

const emailBodySchema = z
  .object({ recipientEmail: z.string().email().max(320).optional() })
  .strict();

function mapReportError(error: unknown): unknown {
  if (error instanceof ReportNotFoundError) return new NotFoundError("Report", "unknown");
  return error;
}

export interface ReportsRouterDeps {
  readonly db: ProfitDb;
  readonly jwt: JwtService;
  readonly logger: Logger;
  readonly provider: AiProvider | null;
  readonly emailSender: EmailSender | null;
}

export function reportsRouter(deps: ReportsRouterDeps): ExpressRouter {
  const router = Router();
  const service = new ReportService({
    db: deps.db,
    logger: deps.logger,
    provider: deps.provider,
    emailSender: deps.emailSender,
  });

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  /** Report vault (optional ?kind filter), newest periods first. */
  router.get("/", requirePermission("reports:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const kindParam = req.query["kind"];
      const kind =
        kindParam === undefined
          ? undefined
          : (Object.values(ReportKind) as string[]).includes(String(kindParam))
            ? (String(kindParam) as (typeof ReportKind)[keyof typeof ReportKind])
            : (() => {
                throw new ValidationError("invalid kind", [
                  { code: "VALIDATION_FAILED", message: "kind must be DAILY, WEEKLY, MONTHLY or QUARTERLY", field: "kind" },
                ]);
              })();
      const items = await service.list(req.appAuth.storeId, kind);
      res.status(200).json(successEnvelope(getRequestContext(), items));
    } catch (error) {
      next(mapReportError(error));
    }
  });

  /** Manual generation for the current closed period (convergent). */
  router.post("/generate", requirePermission("reports:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const body = generateBodySchema.safeParse(req.body ?? {});
      if (!body.success) throw ValidationError.fromZod(body.error.issues);
      const now = new Date();
      const outcome = await service.generateForPeriod(
        req.appAuth.storeId,
        body.data.kind,
        closedPeriodFor(body.data.kind, now),
        now,
      );
      res.status(201).json(successEnvelope(getRequestContext(), outcome));
    } catch (error) {
      next(mapReportError(error));
    }
  });

  /** Full report detail incl. the deterministic sections payload. */
  router.get("/:id", requirePermission("reports:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const detail = await service.detail(req.appAuth.storeId, req.params["id"]!);
      res.status(200).json(successEnvelope(getRequestContext(), detail));
    } catch (error) {
      next(mapReportError(error));
    }
  });

  /** Downloadable PDF (the byte trail lives in the reports vault). */
  router.get("/:id/pdf", requirePermission("reports:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const pdf = await service.pdfFor(req.appAuth.storeId, req.params["id"]!);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
      res.setHeader("Content-Length", String(pdf.sizeBytes));
      res.status(200).send(pdf.bytes);
    } catch (error) {
      next(mapReportError(error));
    }
  });

  /** Email delivery — idempotent per UTC day; unavailability is a typed outcome. */
  router.post("/:id/email", requirePermission("reports:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const body = emailBodySchema.safeParse(req.body ?? {});
      if (!body.success) throw ValidationError.fromZod(body.error.issues);
      const now = new Date();
      const recipient = body.data.recipientEmail ?? (await service.defaultRecipientFor(req.appAuth.storeId));
      if (recipient === null) {
        throw new ValidationError("recipient required", [
          { code: "VALIDATION_FAILED", message: "no recipient configured — set one in report preferences or pass recipientEmail", field: "recipientEmail" },
        ]);
      }
      const outcome = await service.deliver(req.appAuth.storeId, req.params["id"]!, recipient, now);
      res.status(200).json(successEnvelope(getRequestContext(), outcome));
    } catch (error) {
      next(mapReportError(error));
    }
  });

  return router;
}
