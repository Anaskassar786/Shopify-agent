import { z } from "zod";
import { SubscriptionStatus, UsageMeter, type BillingInterval } from "@profit/types";

/**
 * Plan entitlement parsing (single zod contract for the `plans.entitlements`
 * JSON catalog — pricing is data, never code; P11).
 */

export const planQuotasSchema = z.object({
  aiCalls: z.number().int().nonnegative(),
  emails: z.number().int().nonnegative(),
  sms: z.number().int().nonnegative(),
  automationRuns: z.number().int().nonnegative(),
  seats: z.number().int().nonnegative(),
  stores: z.number().int().nonnegative(),
});

export const planEntitlementsSchema = z.object({
  capabilities: z.array(z.string().min(1)),
  quotas: planQuotasSchema,
});

export type PlanEntitlements = z.infer<typeof planEntitlementsSchema>;
export type PlanQuotas = z.infer<typeof planQuotasSchema>;

const METER_TO_QUOTA_KEY: Record<UsageMeter, keyof PlanQuotas> = {
  [UsageMeter.AiCalls]: "aiCalls",
  [UsageMeter.EmailsSent]: "emails",
  [UsageMeter.SmsSent]: "sms",
  [UsageMeter.AutomationRuns]: "automationRuns",
};

export function parseEntitlements(raw: unknown): PlanEntitlements {
  return planEntitlementsSchema.parse(raw);
}

export function quotaForMeter(entitlements: PlanEntitlements, meter: UsageMeter): number {
  return entitlements.quotas[METER_TO_QUOTA_KEY[meter]];
}

export function priceForInterval(
  plan: { monthlyPriceCents: number; yearlyPriceCents: number },
  interval: BillingInterval,
): number {
  return interval === "MONTHLY" ? plan.monthlyPriceCents : plan.yearlyPriceCents;
}

/** Plan subscription row shape the access evaluator consumes (narrow; no ORM dependency). */
export interface SubscriptionAccessFacts {
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly graceEndsAt: Date | null;
}

export interface AccessDecision {
  /** Revenue actions (AI runs, executions, sends) allowed right now. */
  readonly revenueActionsAllowed: boolean;
  /** Human/audit-facing reason when blocked (surfaced verbatim in UI copy). */
  readonly blockedReason: string | null;
}

/** Grace window after trial expiry before SUSPENDED flips (P4 grace period). */
export const TRIAL_GRACE_DAYS = 2;

/**
 * Effective access — THE single source of truth for "may this store run
 * revenue actions now" (P2 Merchant→Store→Permission→Session→Subscription).
 * Reads are never gated here; only revenue actions.
 *
 *  - TRIALING: full preview until trialEndsAt (then the lifecycle job flips EXPIRED).
 *  - CHARGE_PENDING: merchant is on Shopify's decision page — allowed until the
 *    trial+grace horizon so the flow never bricks mid-decision.
 *  - ACTIVE: allowed.
 *  - PAST_DUE: allowed until graceEndsAt (dunning window), then blocked.
 *  - CANCELLED: remaining pre-paid time honored until currentPeriodEnd.
 *  - TRIAL_EXPIRED / EXPIRED / SUSPENDED: blocked.
 */
export function evaluateAccess(sub: SubscriptionAccessFacts, now: Date): AccessDecision {
  const afterOrNull = (...dates: ReadonlyArray<Date | null>): Date | null => {
    const present = dates.filter((d): d is Date => d !== null && d.getTime() > now.getTime());
    if (present.length === 0) return null;
    return present.reduce((max, d) => (d.getTime() > max.getTime() ? d : max));
  };

  switch (sub.status) {
    case SubscriptionStatus.Trialing: {
      const horizon = afterOrNull(sub.trialEndsAt);
      return horizon !== null
        ? { revenueActionsAllowed: true, blockedReason: null }
        : { revenueActionsAllowed: false, blockedReason: "Your free trial has ended" };
    }
    case SubscriptionStatus.ChargePending: {
      const horizon = afterOrNull(sub.trialEndsAt, sub.graceEndsAt, sub.currentPeriodEnd);
      return horizon !== null
        ? { revenueActionsAllowed: true, blockedReason: null }
        : {
            revenueActionsAllowed: false,
            blockedReason: "Approve or decline the subscription charge in Shopify to continue",
          };
    }
    case SubscriptionStatus.Active:
      return { revenueActionsAllowed: true, blockedReason: null };
    case SubscriptionStatus.PastDue: {
      const horizon = afterOrNull(sub.graceEndsAt);
      return horizon !== null
        ? { revenueActionsAllowed: true, blockedReason: null }
        : { revenueActionsAllowed: false, blockedReason: "Payment is past due and the grace period has ended" };
    }
    case SubscriptionStatus.Cancelled: {
      const horizon = afterOrNull(sub.currentPeriodEnd);
      return horizon !== null
        ? { revenueActionsAllowed: true, blockedReason: null }
        : { revenueActionsAllowed: false, blockedReason: "Your cancelled subscription's paid period has ended" };
    }
    case SubscriptionStatus.TrialExpired:
    case SubscriptionStatus.Expired:
      return { revenueActionsAllowed: false, blockedReason: "Your subscription has expired. Upgrade to continue" };
    case SubscriptionStatus.Suspended:
      return { revenueActionsAllowed: false, blockedReason: "This store's subscription is suspended" };
  }
}
