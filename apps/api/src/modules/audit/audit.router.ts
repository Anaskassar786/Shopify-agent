import { Router, type Router as ExpressRouter } from "express";
import { and, count, desc, eq, gte, ilike, lte } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { auditLogs, withStoreScope } from "@profit/db";
import { AuditResult } from "@profit/types";
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
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/audit-logs (P4 Audit Logs: searchable, filterable timeline of who
 * did what, when, from where). Read-only by design — the trail is append-only;
 * there is no update/delete surface anywhere in the codebase.
 */

const filters = z.object({
  action: z.string().min(1).max(128).optional(),
  result: z
    .enum(Object.values(AuditResult) as [AuditResult, ...AuditResult[]])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export function auditLogsRouter(deps: { db: ProfitDb; jwt: JwtService }): ExpressRouter {
  const router = Router();

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("audit:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const parsed = filters.safeParse(req.query);
      if (!parsed.success) throw ValidationError.fromZod(parsed.error.issues);
      const storeId = req.appAuth.storeId;
      const { page, pageSize } = parsePageParams(req.query);

      const conditions = [eq(auditLogs.storeId, storeId)];
      if (parsed.data.action !== undefined) {
        conditions.push(ilike(auditLogs.action, `${parsed.data.action}%`));
      }
      if (parsed.data.result !== undefined) {
        conditions.push(eq(auditLogs.result, parsed.data.result));
      }
      if (parsed.data.from !== undefined) conditions.push(gte(auditLogs.createdAt, parsed.data.from));
      if (parsed.data.to !== undefined) conditions.push(lte(auditLogs.createdAt, parsed.data.to));

      const where = and(...conditions);
      const [rows, totalRows] = await withStoreScope(deps.db, storeId, async (tx) =>
        Promise.all([
          tx
            .select({
              id: auditLogs.id,
              action: auditLogs.action,
              entityType: auditLogs.entityType,
              entityId: auditLogs.entityId,
              result: auditLogs.result,
              ip: auditLogs.ip,
              userAgent: auditLogs.userAgent,
              userId: auditLogs.userId,
              metadata: auditLogs.metadata,
              createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .where(where)
            .orderBy(desc(auditLogs.createdAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize),
          tx.select({ value: count() }).from(auditLogs).where(where),
        ]),
      );
      const total = Number(totalRows[0]?.value ?? 0);
      res.status(200).json(
        successEnvelope(getRequestContext(), rows, {
          meta: {
            pagination: {
              page,
              pageSize,
              totalItems: total,
              totalPages: Math.ceil(total / pageSize),
            },
          },
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
