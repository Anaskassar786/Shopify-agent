import type { BusinessContext } from "./types";

/**
 * Store Health Score (P9 AI-score hero card, P10 agent output #1) — 100%
 * deterministic: the same context always yields the same score with the same
 * explanation. Six weighted components, each with a plain-language reason the
 * UI renders verbatim — explainability by construction, zero model calls.
 */

export interface HealthComponent {
  readonly key: string;
  readonly label: string;
  /** 0–100 for this component alone. */
  readonly score: number;
  readonly weight: number; // percentage points the component contributes to
  readonly reason: string;
}

export interface StoreHealth {
  readonly score: number; // 0–100 weighted
  readonly components: readonly HealthComponent[];
}

function clampScore(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 100);
}

export function computeStoreHealth(ctx: BusinessContext): StoreHealth {
  const components: HealthComponent[] = [];

  // 1. Revenue trend (25): +20% growth ⇒ 100, −20% ⇒ 0, linear between.
  const trendPct = ctx.revenue.trendPct;
  const trendScore = trendPct === null ? 50 : clampScore(50 + trendPct * 2.5);
  components.push({
    key: "revenue_trend",
    label: "Revenue trend",
    score: trendScore,
    weight: 25,
    reason:
      trendPct === null
        ? "Not enough history to trend revenue yet — scored neutral."
        : `Net sales ${trendPct >= 0 ? "up" : "down"} ${Math.abs(trendPct)}% vs the previous ${ctx.revenue.windowDays} days.`,
  });

  // 2. Refund pressure (15): 0% ⇒ 100, ≥20% ⇒ 0.
  const refundScore = clampScore(100 - ctx.refunds.ratePct * 5);
  components.push({
    key: "refunds",
    label: "Refund pressure",
    score: refundScore,
    weight: 15,
    reason:
      ctx.refunds.cents > 0
        ? `${ctx.refunds.ratePct}% of gross sales value was refunded (${ctx.refunds.count} orders).`
        : "No refunded sales value in the window.",
  });

  // 3. Inventory risk (15): share of selling products that will stock out inside 14 days.
  const selling = ctx.products.topByRevenue.filter((p) => p.units > 0).length;
  const atRiskCount = ctx.products.lowStock.length;
  const inventoryScore =
    selling === 0 ? 50 : clampScore(100 - (atRiskCount / Math.max(selling, 1)) * 100);
  components.push({
    key: "inventory_risk",
    label: "Inventory risk",
    score: inventoryScore,
    weight: 15,
    reason:
      atRiskCount > 0
        ? `${atRiskCount} active product(s) have under 14 days of stock at current velocity.`
        : "No stockout risk on selling products in the next 14 days.",
  });

  // 4. Cart abandonment (15): recovered-potential ratio — 0 abandoned ⇒ 100.
  const abandoned = ctx.checkouts.abandonedCount;
  const completedOrders = ctx.revenue.ordersCount;
  const abandonmentRatio =
    abandoned + completedOrders === 0 ? 0 : abandoned / (abandoned + completedOrders);
  const abandonmentScore = clampScore(100 - abandonmentRatio * 100);
  components.push({
    key: "abandonment",
    label: "Cart abandonment",
    score: abandonmentScore,
    weight: 15,
    reason:
      abandoned > 0
        ? `${abandoned} carts abandoned in 30 days (${(
            ctx.checkouts.abandonedValueCents / 100
          ).toFixed(0)} ${ctx.store.currency} at risk).`
        : "No abandoned carts detected in the window.",
  });

  // 5. Customer base momentum (15): repeat-purchase segment growth proxy.
  const customersTotal = ctx.customers.total;
  const newCustomers = ctx.customers.newLastWindow;
  const momentumScore =
    customersTotal === 0
      ? 50
      : clampScore(50 + ((newCustomers / customersTotal) * 100 - 10) * 2.5);
  components.push({
    key: "customer_momentum",
    label: "Customer momentum",
    score: momentumScore,
    weight: 15,
    reason:
      customersTotal === 0
        ? "No customer history yet — scored neutral."
        : `${newCustomers} new customers in 30 days across a base of ${customersTotal}.`,
  });

  // 6. Data coverage (15): how much of the engine's input plane is hydrated.
  const planes = [
    { name: "orders", hydrated: ctx.revenue.ordersCount > 0 },
    { name: "customers", hydrated: ctx.customers.total > 0 },
    { name: "products", hydrated: ctx.products.trackedCount > 0 },
    { name: "inventory", hydrated: ctx.inventory.trackedVariants > 0 },
  ];
  const hydrated = planes.filter((plane) => plane.hydrated).length;
  const coverageScore = clampScore((hydrated / planes.length) * 100);
  const missing = planes.filter((plane) => !plane.hydrated).map((plane) => plane.name);
  components.push({
    key: "data_coverage",
    label: "Data coverage",
    score: coverageScore,
    weight: 15,
    reason:
      missing.length === 0
        ? "All data planes hydrated — recommendations use the full picture."
        : `Still waiting on ${missing.join(", ")} data — early recommendations are conservative.`,
  });

  const score = clampScore(
    components.reduce((sum, c) => sum + (c.score * c.weight) / 100, 0),
  );
  return { score, components };
}
