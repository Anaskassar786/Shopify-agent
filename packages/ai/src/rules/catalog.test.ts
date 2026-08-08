import { describe, expect, it } from "vitest";
import { ActionType, AiAgentId, Priority, RecommendationType, RiskLevel } from "@profit/types";
import { EXPECTATIONS, RULE_CATALOG, evaluateRules, firingsByAgent } from "./catalog";
import { makeContext } from "../test-support/fixtures";

/**
 * Rule catalog contract (P3: rules run BEFORE AI). Proves: fire/no-fire
 * thresholds, merchant policy gating, deterministic estimates, and that the
 * same input always yields the same output (purity).
 */

describe("cart.abandoned-recovery", () => {
  const cart = {
    token: "tok-1",
    customerId: null,
    firstName: "Mia",
    hasEmail: true,
    totalCents: 9_600,
    currency: "USD",
    itemCount: 2,
    itemsPreview: [{ title: "Alpha Runner", quantity: 2 }],
    webUrl: "https://checkout.example/recover/tok-1",
    createdAt: "2026-08-05T03:00:00.000Z",
    hoursAgo: 9,
  };

  it("fires for eligible carts with deterministic estimates", () => {
    const ctx = makeContext({
      checkouts: { abandonedCount: 1, abandonedValueCents: 9_600, abandoned: [cart] },
    });
    const firings = evaluateRules(ctx).filter((f) => f.ruleId === "cart.abandoned-recovery");
    expect(firings).toHaveLength(1);
    const firing = firings[0]!;
    expect(firing.type).toBe(RecommendationType.RecoverAbandonedCart);
    expect(firing.actionType).toBe(ActionType.SendRecoveryEmail);
    expect(firing.subjects.checkoutTokens).toEqual(["tok-1"]);
    expect(firing.estimatedRevenueCents).toBe(Math.round(9_600 * EXPECTATIONS.cartRecoveryRate));
    expect(firing.estimatedCostCents).toBe(960); // 10% policy discount
    expect(firing.basePriority).toBeDefined();
  });

  it("respects email presence, delay horizon, recovery URL and the off-switch", () => {
    const noEmail = { ...cart, hasEmail: false };
    const tooFresh = { ...cart, token: "tok-2", hoursAgo: 2 };
    const noRecoveryUrl = { ...cart, token: "tok-3", webUrl: null };
    const ctx = makeContext({
      checkouts: {
        abandonedCount: 3,
        abandonedValueCents: 28_800,
        abandoned: [noEmail, tooFresh, noRecoveryUrl],
      },
    });
    expect(evaluateRules(ctx).filter((f) => f.ruleId === "cart.abandoned-recovery")).toHaveLength(0);

    const disabled = makeContext({
      checkouts: { abandonedCount: 1, abandonedValueCents: 9_600, abandoned: [cart] },
      policy: { ...makeContext().policy, abandonedCartEnabled: false },
    });
    expect(evaluateRules(disabled).filter((f) => f.ruleId === "cart.abandoned-recovery")).toHaveLength(0);

    const floorHigh = makeContext({
      checkouts: { abandonedCount: 1, abandonedValueCents: 9_600, abandoned: [cart] },
      policy: { ...makeContext().policy, abandonedCartMinValueCents: 100_000 },
    });
    expect(evaluateRules(floorHigh).filter((f) => f.ruleId === "cart.abandoned-recovery")).toHaveLength(0);
  });

  it("is pure — same input, same firing set", () => {
    const ctx = makeContext({
      checkouts: { abandonedCount: 1, abandonedValueCents: 9_600, abandoned: [cart] },
    });
    expect(evaluateRules(ctx)).toEqual(evaluateRules(ctx));
  });
});

describe("inventory rules", () => {
  it("stockout-risk batches low-stock products with velocity math", () => {
    const ctx = makeContext({
      products: {
        trackedCount: 10,
        topByRevenue: [],
        lowStock: [
          { id: "p1", title: "Fast Shoe", priceCents: 5_000, onHand: 4, velocityPerDay: 2, daysOfStock: 2 },
          { id: "p2", title: "Slow Shoe", priceCents: 3_000, onHand: 20, velocityPerDay: 1.5, daysOfStock: 13 },
        ],
        deadStock: [],
      },
    });
    const firing = evaluateRules(ctx).find((f) => f.ruleId === "inventory.stockout-risk");
    expect(firing).toBeDefined();
    expect(firing?.type).toBe(RecommendationType.Restock);
    expect(firing?.actionType).toBe(ActionType.Advisory);
    expect(firing?.subjects.productIds).toEqual(["p1", "p2"]);
    // (2/day × 14 × 5000) + (1.5/day × 14 × 3000) = 140000 + 63000 = 203000
    expect(firing?.estimatedRevenueCents).toBe(203_000);
    expect(firing?.basePriority).toBe(Priority.Critical); // ≤3 days of stock
  });

  it("dead-stock values parked capital with a clearance discount action", () => {
    const ctx = makeContext({
      products: {
        trackedCount: 10,
        topByRevenue: [],
        lowStock: [],
        deadStock: [
          { id: "p9", title: "Dusty Vase", priceCents: 2_000, onHand: 25, unitsSoldInWindow: 0, daysListed: 120 },
        ],
      },
    });
    const firing = evaluateRules(ctx).find((f) => f.ruleId === "inventory.dead-stock");
    expect(firing).toBeDefined();
    expect(firing?.actionType).toBe(ActionType.CreateDiscountCode);
    // value = 25 × 2000 = 50000; estimate = 25% clearance rate → 12500
    expect(firing?.estimatedRevenueCents).toBe(12_500);
    // cost = 50000 × 20% discount = 10000
    expect(firing?.estimatedCostCents).toBe(10_000);
    expect(firing?.baseRisk).toBe(RiskLevel.Low);
  });
});

describe("customer rules", () => {
  it("win-back fires for 60-180d-inactive repeat customers", () => {
    const ctx = makeContext({
      customers: {
        total: 100,
        newLastWindow: 5,
        vip: [],
        atRisk: [],
        inactive: [
          { id: "c1", firstName: "Al", ltvCents: 50_000, ordersCount: 4, lastOrderAt: null, daysSinceLastOrder: 75 },
        ],
      },
    });
    const firing = evaluateRules(ctx).find((f) => f.ruleId === "customers.winback-inactive");
    expect(firing).toBeDefined();
    expect(firing?.type).toBe(RecommendationType.WinbackInactive);
    expect(firing?.subjects.customerIds).toEqual(["c1"]);
    expect(firing?.estimatedRevenueCents).toBe(Math.round(50_000 * EXPECTATIONS.winbackRate));
  });

  it("VIP appreciation fires only for recently-active VIPs", () => {
    const ctx = makeContext({
      customers: {
        total: 100,
        newLastWindow: 5,
        inactive: [],
        atRisk: [],
        vip: [
          { id: "c9", firstName: "Big", ltvCents: 900_000, ordersCount: 12, lastOrderAt: null, daysSinceLastOrder: 20 },
          { id: "c8", firstName: "Old", ltvCents: 800_000, ordersCount: 9, lastOrderAt: null, daysSinceLastOrder: 300 },
        ],
      },
    });
    const firing = evaluateRules(ctx).find((f) => f.ruleId === "customers.vip-appreciation");
    expect(firing).toBeDefined();
    expect(firing?.subjects.customerIds).toEqual(["c9"]); // c8 too quiet to be "recently active"
    expect(firing?.type).toBe(RecommendationType.TargetVip);
  });
});

describe("business analyst rules", () => {
  it("refund-pressure fires above the volume-guarded threshold", () => {
    const ctx = makeContext({ refunds: { count: 7, cents: 12_000, ratePct: 11 } });
    const firing = evaluateRules(ctx).find((f) => f.ruleId === "revenue.refund-pressure");
    expect(firing).toBeDefined();
    expect(firing?.type).toBe(RecommendationType.ReduceRefundRisk);
    expect(firing?.agentId).toBe(AiAgentId.BusinessAnalyst);

    const quiet = makeContext({ refunds: { count: 1, cents: 2_000, ratePct: 9 } });
    expect(evaluateRules(quiet).find((f) => f.ruleId === "revenue.refund-pressure")).toBeUndefined();
  });

  it("revenue decline requires ≥15% drop AND a meaningful prior volume", () => {
    const declining = makeContext({
      revenue: { ...makeContext().revenue, trendPct: -22, priorNetCents: 400_000, netCents: 312_000 },
    });
    const firing = evaluateRules(declining).find((f) => f.ruleId === "revenue.decline-review");
    expect(firing).toBeDefined();

    const tiny = makeContext({
      revenue: { ...makeContext().revenue, trendPct: -40, priorNetCents: 5_000, netCents: 3_000 },
    });
    expect(evaluateRules(tiny).find((f) => f.ruleId === "revenue.decline-review")).toBeUndefined();
  });
});

describe("promotion window", () => {
  it("fires only on stable momentum with at-risk regulars and enough volume", () => {
    const eligible = makeContext({
      customers: {
        ...makeContext().customers,
        atRisk: [
          { id: "a1", firstName: null, ltvCents: 10_000, ordersCount: 3, lastOrderAt: null, daysSinceLastOrder: 40 },
          { id: "a2", firstName: null, ltvCents: 10_000, ordersCount: 2, lastOrderAt: null, daysSinceLastOrder: 41 },
          { id: "a3", firstName: null, ltvCents: 10_000, ordersCount: 2, lastOrderAt: null, daysSinceLastOrder: 42 },
        ],
      },
    });
    const firing = evaluateRules(eligible).find((f) => f.ruleId === "growth.promotion-window");
    expect(firing).toBeDefined();
    expect(firing?.actionType).toBe(ActionType.CreateDiscountCode);

    const noVolume = makeContext({
      revenue: { ...makeContext().revenue, ordersCount: 5 },
    });
    expect(evaluateRules(noVolume).find((f) => f.ruleId === "growth.promotion-window")).toBeUndefined();
  });
});

describe("pricing.momentum-uplift (M8, ADR 36)", () => {
  it("fires only on demand outpacing cover; advisory margin math from documented constants", () => {
    const ctx = makeContext({
      products: {
        trackedCount: 10,
        topByRevenue: [],
        lowStock: [
          { id: "p1", title: "Fast Kettle", priceCents: 5_000, onHand: 9, velocityPerDay: 3, daysOfStock: 3 },
          { id: "p2", title: "Gentle Kettle", priceCents: 5_000, onHand: 40, velocityPerDay: 3.1, daysOfStock: 12 },
          { id: "p3", title: "Barely Kettle", priceCents: 5_000, onHand: 2, velocityPerDay: 0.5, daysOfStock: 4 },
        ],
        deadStock: [],
      },
    });
    const firing = evaluateRules(ctx).find((f) => f.ruleId === "pricing.momentum-uplift");
    expect(firing).toBeDefined();
    expect(firing?.agentId).toBe(AiAgentId.Pricing);
    expect(firing?.type).toBe(RecommendationType.AdjustPrice);
    // Strictly ADVISORY — the engine never changes prices itself.
    expect(firing?.actionType).toBe(ActionType.Advisory);
    // Only p1 qualifies: velocity ≥ 1 AND cover ≤ 10 days.
    expect(firing?.subjects.productIds).toEqual(["p1"]);
    // horizon = 3/day × 14 × 5000 = 210000; uplift 5% × retention 95% → 9975
    expect(firing?.estimatedRevenueCents).toBe(9_975);
    // jeopardized demand = 210000 × 5% non-retained → 10500
    expect(firing?.estimatedCostCents).toBe(10_500);
    expect(firing?.baseRisk).toBe(RiskLevel.Medium);
    expect(firing?.expiresInDays).toBe(7);
  });

  it("stays silent without the pricing signal (no fake margin opportunities)", () => {
    const ctx = makeContext({
      products: {
        trackedCount: 2,
        topByRevenue: [],
        lowStock: [
          { id: "p2", title: "Covered Kettle", priceCents: 5_000, onHand: 40, velocityPerDay: 3, daysOfStock: 13 },
        ],
        deadStock: [],
      },
    });
    expect(evaluateRules(ctx).find((f) => f.ruleId === "pricing.momentum-uplift")).toBeUndefined();
  });
});

describe("catalog integrity", () => {
  it("one deterministic rule per type, all agents mapped, versions positive", () => {
    const types = new Set(RULE_CATALOG.map((rule) => rule.type));
    expect(types.size).toBe(RULE_CATALOG.length);
    for (const rule of RULE_CATALOG) {
      expect(rule.version).toBeGreaterThan(0);
      expect(Object.values(AiAgentId)).toContain(rule.agentId);
    }
  });

  it("firingsByAgent partitions by owning agent", () => {
    const ctx = makeContext({
      checkouts: {
        abandonedCount: 1,
        abandonedValueCents: 9_600,
        abandoned: [{
          token: "t", customerId: null, firstName: null, hasEmail: true, totalCents: 9_600,
          currency: "USD", itemCount: 1, itemsPreview: [], webUrl: "https://x", createdAt: "2026-08-05T00:00:00Z", hoursAgo: 12,
        }],
      },
    });
    const all = evaluateRules(ctx);
    expect(firingsByAgent(all, AiAgentId.RevenueRecovery).length).toBe(all.length);
    expect(firingsByAgent(all, AiAgentId.Inventory).length).toBe(0);
  });
});
