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
 * /api/v1/ai — the AI Command Center surface (P9): engine status, store
 * health, open pipeline counts, acceptance + attributed-revenue totals, and
 * the append-only activity feed. Read-only by construction.
 */
export function aiRouter(deps: { db: ProfitDb; jwt: JwtService }): ExpressRouter {
  const router = Router();
  const service = new AiOverviewService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/overview", requirePermission("recommendations:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const overview = await service.overview(req.appAuth.storeId);
      res.status(200).json(successEnvelope(getRequestContext(), overview));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
