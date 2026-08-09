import { describe, expect, it } from "vitest";
import { BillingInterval, SubscriptionStatus, UsageMeter } from "@profit/types";
import {
  evaluateAccess,
  parseEntitlements,
  priceForInterval,
  quotaForMeter,
  TRIAL_GRACE_DAYS,
  type SubscriptionAccessFacts,
} from "./plans";

const entitlement = {
  capabilities: ["dashboard", "automation"],
  quotas: { aiCalls: 2000, emails: 10_000, sms: 0, automationRuns: 1000, seats: 3, stores: 1 },
};

const facts = (overrides: Partial<SubscriptionAccessFacts>): SubscriptionAccessFacts => ({
  status: SubscriptionStatus.Trialing,
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceEndsAt: null,
  ...overrides,
});

const NOW = new Date("2026-08-06T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const inDays = (days: number): Date => new Date(NOW.getTime() + days * DAY);

describe("parseEntitlements", () => {
  it("parses the seeded catalog shape", () => {
    expect(parseEntitlements(entitlement)).toEqual(entitlement);
  });

  it("rejects malformed catalogs (pricing is data, never untyped)", () => {
    expect(() => parseEntitlements({ capabilities: [], quotas: { aiCalls: -1 } })).toThrow();
    expect(() => parseEntitlements("{}")).toThrow();
    expect(() =>
      parseEntitlements({ capabilities: ["x"], quotas: { ...entitlement.quotas, emails: 1.5 } }),
    ).toThrow();
  });
});

describe("quotaForMeter", () => {
  it("maps every meter to its quota key", () => {
    const parsed = parseEntitlements(entitlement);
    expect(quotaForMeter(parsed, UsageMeter.AiCalls)).toBe(2000);
    expect(quotaForMeter(parsed, UsageMeter.EmailsSent)).toBe(10_000);
    expect(quotaForMeter(parsed, UsageMeter.SmsSent)).toBe(0);
    expect(quotaForMeter(parsed, UsageMeter.AutomationRuns)).toBe(1000);
  });
});

describe("priceForInterval", () => {
  const plan = { monthlyPriceCents: 7900, yearlyPriceCents: 79_000 };
  it("picks the cadence price", () => {
    expect(priceForInterval(plan, BillingInterval.Monthly)).toBe(7900);
    expect(priceForInterval(plan, BillingInterval.Yearly)).toBe(79_000);
  });
});

describe("evaluateAccess — the revenue-action state machine", () => {
  it("TRIALING is a full preview until trialEndsAt", () => {
    expect(evaluateAccess(facts({ trialEndsAt: inDays(2) }), NOW)).toEqual({
      revenueActionsAllowed: true,
      blockedReason: null,
    });
    expect(evaluateAccess(facts({ trialEndsAt: inDays(-1) }), NOW)).toEqual({
      revenueActionsAllowed: false,
      blockedReason: "Your free trial has ended",
    });
    expect(evaluateAccess(facts({ trialEndsAt: null }), NOW).revenueActionsAllowed).toBe(false);
  });

  it("CHARGE_PENDING never bricks mid-decision: honored to the furthest horizon", () => {
    const pending = facts({
      status: SubscriptionStatus.ChargePending,
      trialEndsAt: inDays(-1),
      graceEndsAt: inDays(1),
      currentPeriodEnd: inDays(-2),
    });
    expect(evaluateAccess(pending, NOW).revenueActionsAllowed).toBe(true);

    const expiredEverywhere = facts({
      status: SubscriptionStatus.ChargePending,
      trialEndsAt: inDays(-3),
      graceEndsAt: inDays(-1),
      currentPeriodEnd: inDays(-2),
    });
    const decision = evaluateAccess(expiredEverywhere, NOW);
    expect(decision.revenueActionsAllowed).toBe(false);
    expect(decision.blockedReason).toContain("Approve or decline");
  });

  it("ACTIVE always allows", () => {
    expect(evaluateAccess(facts({ status: SubscriptionStatus.Active }), NOW)).toEqual({
      revenueActionsAllowed: true,
      blockedReason: null,
    });
  });

  it("PAST_DUE honors the dunning window, then blocks", () => {
    expect(
      evaluateAccess(facts({ status: SubscriptionStatus.PastDue, graceEndsAt: inDays(1) }), NOW)
        .revenueActionsAllowed,
    ).toBe(true);
    const decision = evaluateAccess(
      facts({ status: SubscriptionStatus.PastDue, graceEndsAt: inDays(-1) }),
      NOW,
    );
    expect(decision.revenueActionsAllowed).toBe(false);
    expect(decision.blockedReason).toContain("past due");
    expect(
      evaluateAccess(facts({ status: SubscriptionStatus.PastDue, graceEndsAt: null }), NOW)
        .revenueActionsAllowed,
    ).toBe(false);
  });

  it("CANCELLED keeps pre-paid time, not a second longer", () => {
    expect(
      evaluateAccess(facts({ status: SubscriptionStatus.Cancelled, currentPeriodEnd: inDays(5) }), NOW)
        .revenueActionsAllowed,
    ).toBe(true);
    const decision = evaluateAccess(
      facts({ status: SubscriptionStatus.Cancelled, currentPeriodEnd: inDays(-1) }),
      NOW,
    );
    expect(decision.revenueActionsAllowed).toBe(false);
    expect(decision.blockedReason).toContain("paid period has ended");
  });

  it("TRIAL_EXPIRED / EXPIRED / SUSPENDED block with UI-ready copy", () => {
    expect(
      evaluateAccess(facts({ status: SubscriptionStatus.TrialExpired }), NOW).blockedReason,
    ).toContain("Upgrade to continue");
    expect(
      evaluateAccess(facts({ status: SubscriptionStatus.Expired }), NOW).revenueActionsAllowed,
    ).toBe(false);
    expect(evaluateAccess(facts({ status: SubscriptionStatus.Suspended }), NOW)).toEqual({
      revenueActionsAllowed: false,
      blockedReason: "This store's subscription is suspended",
    });
  });

  it("grace constant is the documented P4 grace period", () => {
    expect(TRIAL_GRACE_DAYS).toBe(2);
  });
});
