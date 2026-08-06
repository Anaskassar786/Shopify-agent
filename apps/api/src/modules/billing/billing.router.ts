import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import { eq, stores, subscriptions } from "@profit/db";
import {
  BillingConflictError,
  BillingProviderUnavailableError,
  BillingService,
  EngagementService,
  type BillingChargeProvider,
} from "@profit/billing";
import {
  BillingInterval,
  EngagementEventKind,
  NotificationCategory,
  PlanCode,
} from "@profit/types";
import type { NotificationService } from "@profit/notifications";
import type { Logger } from "@profit/logger";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import {
  BillingUnavailableError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";
import type { AuditService } from "../audit/audit.service";

/**
 * /api/v1/billing (M5, P2/P7/P11): plans, usage, history, subscribe, cancel —
 * plus the PUBLIC Shopify charge callback (mounted before auth: Shopify's
 * decision screen is a top-level redirect without session headers; its trust
 * comes from re-reading the charge through the Admin API, never from URL data).
 */
export interface BillingRouterDeps {
  db: ProfitDb;
  jwt: JwtService;
  audit: AuditService;
  notifications: NotificationService;
  logger: Logger;
  /** Per-store provider factory (resolves the OFFLINE token at the composition root). */
  providerFor: (storeId: string) => Promise<BillingChargeProvider | null>;
  billingTest: boolean;
  /** Absolute public URL of THIS api (callback returnUrl built from it). */
  appUrl: string;
  /** SHOPIFY_API_KEY — builds the embedded-admin bounce URL after the callback. */
  shopifyApiKey: string | undefined;
}

const subscribeSchema = z
  .object({
    planCode: z.enum(Object.values(PlanCode) as [PlanCode, ...PlanCode[]]),
    interval: z.enum(Object.values(BillingInterval) as [BillingInterval, ...BillingInterval[]]),
  })
  .strict();

export function billingRouter(deps: BillingRouterDeps): ExpressRouter {
  const router = Router();
  const billing = new BillingService(deps.db);
  const engagement = new EngagementService(deps.db);

  /** Embedded-app home for the post-callback bounce (query state rides into the iframe). */
  function adminAppsUrl(shopDomain: string, state: string): string {
    if (deps.shopifyApiKey === undefined) {
      return `${deps.appUrl}/billing?billing_state=${state}`;
    }
    return `https://${shopDomain}/admin/apps/${deps.shopifyApiKey}?billing_state=${state}`;
  }

  /**
   * Public charge callback. URL parameters are never trusted: the charge id
   * only ADDRESSES our pending row; acceptance is read back from Shopify.
   */
  router.get("/callback", async (req, res, next) => {
    try {
      const chargeId = typeof req.query["charge_id"] === "string" ? req.query["charge_id"] : null;
      if (chargeId === null) throw new ValidationError("charge_id is required");
      const rows = await deps.db
        .select({ storeId: subscriptions.storeId })
        .from(subscriptions)
        .where(eq(subscriptions.shopifyChargeId, chargeId))
        .limit(1);
      const found = rows[0];
      if (found === undefined) throw new NotFoundError("no pending subscription matches this charge");
      const storeId = found.storeId;

      const storeRows = await deps.db
        .select({ shopDomain: stores.shopDomain })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const shopDomain = storeRows[0]?.shopDomain;
      if (shopDomain === undefined) throw new NotFoundError("store not found for charge");

      const provider = await deps.providerFor(storeId);
      if (provider === null) throw new BillingUnavailableError();
      const outcome = await billing.resolveChargeOutcome({ storeId, provider, source: "CALLBACK" });

      if (outcome.outcome === "ACTIVATED") {
        // Funnel telemetry is observability: activation is already committed,
        // so an emit failure must never turn the merchant's redirect into a 500.
        try {
          await engagement.emit({ storeId, kind: EngagementEventKind.PaidSubscriptionStarted });
        } catch (error) {
          deps.logger.warn({ err: error, storeId }, "engagement.paid_subscription_started.failed");
        }
        await deps.notifications.create(storeId, {
          category: NotificationCategory.Billing,
          title: "Subscription activated",
          body: "Your paid plan is now active — automation, AI runs and measurement continue without interruption.",
          actionUrl: "/billing",
        });
        deps.audit.recordDetached({
          storeId,
          action: "billing.subscription.activated",
          entityType: "subscription",
          entityId: outcome.chargeId,
          result: "SUCCESS",
          metadata: { source: "callback", interval: outcome.interval },
        });
        res.redirect(302, adminAppsUrl(shopDomain, "activated"));
      } else if (outcome.outcome === "DECLINED") {
        deps.audit.recordDetached({
          storeId,
          action: "billing.subscription.declined",
          entityType: "subscription",
          entityId: outcome.chargeId ?? chargeId,
          result: "FAILURE",
          metadata: { source: "callback" },
        });
        res.redirect(302, adminAppsUrl(shopDomain, "declined"));
      } else {
        res.redirect(302, adminAppsUrl(shopDomain, outcome.outcome === "PENDING" ? "pending" : "pending"));
      }
    } catch (error) {
      next(error);
    }
  });

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  /** Page overview: subscription state + entitlements + live usage bundle. */
  router.get("/overview", requirePermission("billing:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const storeId = req.appAuth.storeId;
      const [state, usage, access] = await Promise.all([
        billing.getSubscriptionState(storeId),
        billing.usageSummary(storeId),
        billing.evaluateStoreAccess(storeId),
      ]);
      res.status(200).json(
        successEnvelope(getRequestContext(), {
          ...state,
          usage,
          access: {
            revenueActionsAllowed: access.revenueActionsAllowed,
            blockedReason: access.blockedReason,
          },
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/plans", requirePermission("billing:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const storeId = req.appAuth.storeId;
      const catalog = await billing.listPlans(storeId);
      res.status(200).json(successEnvelope(getRequestContext(), catalog));
    } catch (error) {
      next(error);
    }
  });

  router.get("/history", requirePermission("billing:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const rows = await billing.history(req.appAuth.storeId);
      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(error);
    }
  });

  router.post("/subscribe", requirePermission("billing:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const { storeId, userId } = req.appAuth;
      const body = subscribeSchema.parse(req.body);
      const provider = await deps.providerFor(storeId);
      if (provider === null) throw new BillingUnavailableError();
      try {
        const result = await billing.subscribe({
          storeId,
          planCode: body.planCode,
          interval: body.interval,
          provider,
          returnUrl: `${deps.appUrl}/api/v1/billing/callback`,
          test: deps.billingTest,
        });
        deps.audit.recordDetached({
          storeId,
          userId,
          action: "billing.subscription.charge_started",
          entityType: "subscription",
          entityId: result.chargeId,
          result: "SUCCESS",
          metadata: { planCode: body.planCode, interval: body.interval, test: deps.billingTest },
        });
        res.status(201).json(successEnvelope(getRequestContext(), result));
      } catch (error) {
        if (error instanceof BillingConflictError) {
          throw new ForbiddenError(error.message, error.details);
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/cancel", requirePermission("billing:manage"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const { storeId, userId } = req.appAuth;
      const provider = await deps.providerFor(storeId);
      if (provider === null) throw new BillingUnavailableError();
      try {
        await billing.cancel({ storeId, provider });
      } catch (error) {
        if (error instanceof BillingConflictError) {
          throw new ForbiddenError(error.message, error.details);
        }
        throw error;
      }
      deps.audit.recordDetached({
        storeId,
        userId,
        action: "billing.subscription.cancelled",
        entityType: "subscription",
        result: "SUCCESS",
      });
      res.status(200).json(successEnvelope(getRequestContext(), { cancelled: true }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
