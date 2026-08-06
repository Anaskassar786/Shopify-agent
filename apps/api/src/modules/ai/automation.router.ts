import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import { AiOverviewService } from "@profit/ai";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/automation — the Automation surface (P3 modes + v1 abandoned-cart
 * autopilot): current merchant policy (from store_settings, edited via
 * /store/settings) + tool execution ledger + attributed outcomes. Read-only;
 * configuration flows through the store settings channel (one settings API).
 */
export function automationRouter(deps: { db: ProfitDb; jwt: JwtService }): ExpressRouter {
  const router = Router();
  const service = new AiOverviewService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/overview", requirePermission("automation:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const overview = await service.automationOverview(req.appAuth.storeId);
      res.status(200).json(successEnvelope(getRequestContext(), overview));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
