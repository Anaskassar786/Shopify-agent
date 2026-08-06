import { Router, type Router as ExpressRouter } from "express";
import type { JwtService } from "../auth/jwt.service";
import type { NotificationService } from "@profit/notifications";
import { NotificationCategory } from "@profit/types";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { ValidationError } from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import { parsePageParams } from "../../lib/http/pagination";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { ProfitDb } from "@profit/db";

/**
 * /api/v1/notifications (P4 Notification Center). Reads/marks ride the shared
 * NotificationService — the same code the worker writes through, so the drawer
 * and the producers can never disagree about audience or persistence.
 */

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  unreadOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  category: z.enum(Object.values(NotificationCategory) as [NotificationCategory, ...NotificationCategory[]]).optional(),
});

export function notificationsRouter(deps: {
  db: ProfitDb;
  jwt: JwtService;
  notifications: NotificationService;
}): ExpressRouter {
  const router = Router();

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("notifications:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) throw ValidationError.fromZod(parsed.error.issues);
      const page = parsePageParams(req.query);
      const result = await deps.notifications.list(req.appAuth.storeId, {
        userId: req.appAuth.userId,
        page: page.page,
        pageSize: page.pageSize,
        unreadOnly: parsed.data.unreadOnly,
        category: parsed.data.category,
      });
      res.status(200).json(
        successEnvelope(getRequestContext(), result.rows, {
          meta: {
            pagination: {
              page: page.page,
              pageSize: page.pageSize,
              totalItems: result.total,
              totalPages: Math.ceil(result.total / page.pageSize),
            },
            extras: { unread: result.unread },
          },
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/read", requirePermission("notifications:update"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const row = await deps.notifications.markRead(
        req.appAuth.storeId,
        String(req.params["id"]),
        req.appAuth.userId,
      );
      // Audience mismatch and non-existence intentionally look identical.
      res.status(200).json(successEnvelope(getRequestContext(), row));
    } catch (error) {
      next(error);
    }
  });

  router.post("/read-all", requirePermission("notifications:update"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const flipped = await deps.notifications.markAllRead(
        req.appAuth.storeId,
        req.appAuth.userId,
      );
      res.status(200).json(successEnvelope(getRequestContext(), { markedRead: flipped }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
