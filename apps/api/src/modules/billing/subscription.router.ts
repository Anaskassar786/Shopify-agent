import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import { BillingService } from "@profit/billing";
import { PlanCode } from "@profit/types";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";
import type { AuditService } from "../audit/audit.service";
import type { Logger } from "@profit/logger";

/**
 * /api/v1/subscription (P4/P11 trial experience). Thin HTTP adapter over the
 * shared BillingService (M5): the trial start lives in ONE engine consumed by
 * this router and the worker jobs; Shopify charges live in billing.router.
 */
export function subscriptionRouter(deps: {
  db: ProfitDb;
  jwt: JwtService;
  audit: AuditService;
  logger: Logger;
  defaultPlanCode?: string | undefined;
}): ExpressRouter {
  const planCodeSchema = z.enum(
    Object.values(PlanCode) as [PlanCode, ...PlanCode[]],
  );
  const router = Router();
  const billing = new BillingService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("billing:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const result = await billing.getSubscriptionState(req.appAuth.storeId);
      res.status(200).json(successEnvelope(getRequestContext(), result));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Start the free trial (P4 onboarding: "... → start trial"). Idempotent:
   * a store already TRIALING/ACTIVE gets its current row back unchanged —
   * double-clicks and re-opened wizards can never create a second trial.
   */
  router.post("/start-trial", requirePermission("billing:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const { storeId, userId } = req.appAuth;
      const code = deps.defaultPlanCode !== undefined
        ? planCodeSchema.catch(PlanCode.Growth).parse(deps.defaultPlanCode)
        : PlanCode.Growth;
      const started = await billing.startTrial(storeId, code);
      if (started.created) {
        await deps.audit.record({
          storeId,
          userId,
          action: "billing.subscription.trial_started",
          entityType: "subscription",
          entityId: started.subscription.id,
          result: "SUCCESS",
          metadata: {
            planCode: code,
            trialEndsAt: started.subscription.trialEndsAt,
          },
        });
      }
      res
        .status(started.created ? 201 : 200)
        .json(successEnvelope(getRequestContext(), started.subscription));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
