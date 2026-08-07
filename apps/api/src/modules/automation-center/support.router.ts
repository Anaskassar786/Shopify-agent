import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import { SupportService } from "@profit/automation";
import { SupportTicketCategory, SupportTicketPriority } from "@profit/types";
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
 * /api/v1/support (M6): merchant-side ticket threads. Real persistence +
 * lifecycle (open → waiting-on-customer → resolved/closed), reopen-on-reply
 * semantics enforced by the service.
 */

const createSchema = z
  .object({
    subject: z.string().min(1).max(200),
    category: z.enum(
      Object.values(SupportTicketCategory) as [SupportTicketCategory, ...SupportTicketCategory[]],
    ),
    priority: z
      .enum(Object.values(SupportTicketPriority) as [SupportTicketPriority, ...SupportTicketPriority[]])
      .optional(),
    body: z.string().min(1).max(10_000),
  })
  .strict();

const replySchema = z.object({ body: z.string().min(1).max(10_000) }).strict();

export function supportRouter(deps: {
  db: ProfitDb;
  jwt: JwtService;
  audit: AuditService;
}): ExpressRouter {
  const router = Router();
  const support = new SupportService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/tickets", requirePermission("support:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
      const result = await support.listTickets(req.appAuth.storeId, page, pageSize);
      res.status(200).json(successEnvelope(getRequestContext(), result));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/tickets", requirePermission("support:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = createSchema.parse(req.body);
      const row = await support.createTicket(req.appAuth.storeId, {
        openedByUserId: req.appAuth.userId,
        subject: body.subject,
        category: body.category,
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        body: body.body,
      });
      deps.audit.recordDetached({
        storeId: req.appAuth.storeId,
        userId: req.appAuth.userId,
        action: "support.ticket_opened",
        entityType: "support_ticket",
        entityId: row.id,
        result: "SUCCESS",
        metadata: { category: body.category },
      });
      res.status(201).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.get("/tickets/:ticketId", requirePermission("support:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const row = await support.getTicket(req.appAuth.storeId, req.params["ticketId"]!);
      if (row === null) throw new NotFoundError("support ticket", req.params["ticketId"]);
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/tickets/:ticketId/reply", requirePermission("support:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = replySchema.parse(req.body);
      const row = await support.replyAsMerchant(
        req.appAuth.storeId,
        req.params["ticketId"]!,
        req.appAuth.userId,
        body.body,
      );
      res.status(201).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  router.post("/tickets/:ticketId/close", requirePermission("support:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const row = await support.closeByMerchant(req.appAuth.storeId, req.params["ticketId"]!);
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(passThroughAutomationError(error));
    }
  });

  return router;
}
