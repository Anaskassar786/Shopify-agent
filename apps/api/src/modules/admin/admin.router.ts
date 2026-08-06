import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import { GrowthAnalyticsService } from "@profit/billing";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import { parsePageParams } from "../../lib/http/pagination";
import { requirePlatformAdmin } from "../../middleware/platform-admin.middleware";
import type { AuditService } from "../audit/audit.service";

/**
 * /api/v1/admin (M5 Super Admin panel v1, P4/P12): READ-ONLY platform
 * observability for operators — merchants, funnel, modeled MRR, AI usage,
 * worker/system health. Cross-tenant by design (the documented, audited
 * exception); every request is key-gated + audit-logged. Write actions are
 * deliberately deferred to M6 (stronger operator auth lands with them).
 */
export function adminRouter(deps: {
  db: ProfitDb;
  platformAdminKey: string | undefined;
  audit: AuditService;
}): ExpressRouter {
  const router = Router();
  const growth = new GrowthAnalyticsService(deps.db);

  router.use(requirePlatformAdmin({ platformAdminKey: deps.platformAdminKey, audit: deps.audit }));

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

  return router;
}
