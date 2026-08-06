import { Router, type Router as ExpressRouter } from "express";
import { eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { plans, subscriptions, withStoreScope } from "@profit/db";
import { PlanCode, SubscriptionStatus } from "@profit/types";
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
 * /api/v1/subscription (P4/P11 trial experience; real Shopify charges arrive
 * in M5 — until then the trial state is fully owned here: starting the trial
 * writes the subscription row + audit trail, and every renewal/charge flow
 * lands behind this same router's contract upgrade).
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

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("billing:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const result = await withStoreScope(deps.db, storeId, async (tx) => {
        const rows = await tx
          .select({ subscription: subscriptions, plan: plans })
          .from(subscriptions)
          .innerJoin(plans, eq(subscriptions.planId, plans.id))
          .where(eq(subscriptions.storeId, storeId))
          .limit(1);
        if (rows[0] === undefined) return { subscription: null, plan: null };
        return { subscription: rows[0].subscription, plan: rows[0].plan };
      });
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
      const started = await withStoreScope(deps.db, storeId, async (tx) => {
        const existing = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.storeId, storeId))
          .limit(1);
        if (existing[0] !== undefined) {
          return { row: existing[0], created: false, planCode: null as string | null };
        }
        const code = deps.defaultPlanCode !== undefined
          ? planCodeSchema.catch(PlanCode.Growth).parse(deps.defaultPlanCode)
          : PlanCode.Growth;
        const planRows = await tx.select().from(plans).where(eq(plans.code, code)).limit(1);
        const plan = planRows[0];
        if (plan === undefined) throw new Error(`default plan not seeded: ${code}`);
        const trialEndsAt = new Date(Date.now() + plan.trialDays * 24 * 60 * 60 * 1000);
        const inserted = await tx
          .insert(subscriptions)
          .values({
            storeId,
            planId: plan.id,
            status: SubscriptionStatus.Trialing,
            trialEndsAt,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) throw new Error("subscription insert returned no row");
        return { row, created: true, planCode: code as string | null };
      });
      if (started.created) {
        await deps.audit.record({
          storeId,
          userId,
          action: "billing.subscription.trial_started",
          entityType: "subscription",
          entityId: started.row.id,
          result: "SUCCESS",
          metadata: {
            planCode: started.planCode,
            trialEndsAt: started.row.trialEndsAt,
          },
        });
      }
      res
        .status(started.created ? 201 : 200)
        .json(successEnvelope(getRequestContext(), started.row));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
