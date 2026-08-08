import { desc, eq, inArray, and, type ProfitDb } from "@profit/db";
import { recommendations, withStoreScope } from "@profit/db";
import { ForecastService, type StoreForecastDto } from "@profit/forecasting";
import {
  ActionType,
  CopilotIntent,
  ForecastMethod,
  RecommendationStatus,
  RecommendationType,
  type CopilotIntent as CopilotIntentValue,
  type RecommendationType as RecommendationTypeValue,
} from "@profit/types";
import { buildBusinessContext } from "../context/builder";
import type { BusinessContext } from "../context/types";
import { evaluateRules } from "../rules/catalog";
import type { IntentClassification } from "./intents";

/**
 * Copilot evidence plane (ADR 32): answers render FROM these structures, so a
 * copilot answer can never drift from the numbers dashboards and reports show
 * — every builder reads the SAME M2 aggregates through the SAME context
 * builder and M8 ForecastService. Money is formatted here (cents → currency)
 * so the deterministic renderer and the persisted payload are byte-identical.
 */

export interface EvidenceTable {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface RecommendationRef {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

export interface CopilotEvidence {
  readonly intent: CopilotIntentValue;
  readonly matchedPattern: string | null;
  readonly headline: string;
  readonly bullets: readonly string[];
  readonly tables: readonly EvidenceTable[];
  readonly recommendationRefs: readonly RecommendationRef[];
  /** Method stamp (ForecastMethod.* | context.v1 | rules.v1 | none). */
  readonly method: string;
  /** Honesty score 0-100 from data completeness — never invented. */
  readonly confidence: number;
  readonly currency: string;
  readonly windowLabel: string;
}

export const COPILOT_HORIZON_DAYS = 14 as const;

/** Deterministic confidence: more daily history + customer coverage ⇒ higher. */
export function dataConfidence(dailyDays: number, hasCustomers: boolean): number {
  return Math.min(90, Math.round(35 + dailyDays * 1.5 + (hasCustomers ? 10 : 0)));
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${value > 0 ? "+" : ""}${value}%`;
}

interface IntentInputs {
  readonly ctx: BusinessContext;
  readonly forecast: () => Promise<StoreForecastDto>;
  readonly openRecs: readonly RecommendationRef[];
}

type IntentEvidenceBuilder = (input: IntentInputs) => Promise<Omit<CopilotEvidence, "intent" | "matchedPattern" | "currency" | "windowLabel">>;

function recTypesForIntent(intent: CopilotIntentValue): readonly RecommendationTypeValue[] {
  switch (intent) {
    case CopilotIntent.SalesWhyDown:
      return [RecommendationType.RevenueDeclineReview, RecommendationType.ReduceRefundRisk];
    case CopilotIntent.RestockWhat:
      return [RecommendationType.Restock];
    case CopilotIntent.VipCustomers:
      return [RecommendationType.TargetVip];
    case CopilotIntent.ChurnRisks:
      return [RecommendationType.WinbackInactive, RecommendationType.LaunchPromotion];
    case CopilotIntent.ProductsDying:
    case CopilotIntent.DiscountSuggestion:
      return [
        RecommendationType.RemoveDeadStock,
        RecommendationType.LaunchPromotion,
        RecommendationType.TargetVip,
        RecommendationType.WinbackInactive,
        RecommendationType.RecoverAbandonedCart,
      ];
    case CopilotIntent.GeneralOther:
      return [];
    default:
      return [
        RecommendationType.Restock,
        RecommendationType.RevenueDeclineReview,
        RecommendationType.ReduceRefundRisk,
        RecommendationType.LaunchPromotion,
        RecommendationType.TargetVip,
        RecommendationType.WinbackInactive,
        RecommendationType.RemoveDeadStock,
        RecommendationType.RecoverAbandonedCart,
      ];
  }
}

const intentBuilders: Record<CopilotIntentValue, IntentEvidenceBuilder> = {
  async [CopilotIntent.SalesWhyDown]({ ctx, openRecs }) {
    const currency = ctx.store.currency;
    const trend = ctx.revenue.trendPct;
    const daily = ctx.revenue.daily;
    const recent7 = daily.slice(-7).reduce((sum, day) => sum + day.netCents, 0);
    const previous7 = daily.slice(-14, -7).reduce((sum, day) => sum + day.netCents, 0);
    const declining = trend !== null && trend < 0;
    const bullets = [
      `Net sales last ${ctx.revenue.windowDays} days: ${formatMoney(ctx.revenue.netCents, currency)} (${pct(trend)} vs the previous window).`,
      `Last 7 days: ${formatMoney(recent7, currency)} vs ${formatMoney(previous7, currency)} the week before.`,
      `Orders: ${ctx.revenue.ordersCount} · average order value ${formatMoney(ctx.revenue.aovCents, currency)}.`,
      `Refunds took ${ctx.refunds.ratePct}% of window sales value (${formatMoney(ctx.refunds.cents, currency)} across ${ctx.refunds.count} orders).`,
      `Abandoned carts are holding ${formatMoney(ctx.checkouts.abandonedValueCents, currency)} across ${ctx.checkouts.abandonedCount} open checkouts.`,
    ];
    return {
      headline: declining
        ? `Sales are down ${Math.abs(trend!)}% versus the previous ${ctx.revenue.windowDays}-day window.`
        : `Sales are not down — net sales are ${pct(trend)} versus the previous ${ctx.revenue.windowDays}-day window.`,
      bullets,
      tables: [
        {
          title: `Daily net sales — last ${Math.min(14, daily.length)} days`,
          columns: ["Date", "Net sales", "Orders"],
          rows: daily.slice(-14).map((day) => [day.date, formatMoney(day.netCents, currency), String(day.orders)]),
        },
      ],
      recommendationRefs: openRecs,
      method: "context.v1",
      confidence: dataConfidence(daily.length, ctx.customers.total > 0),
    };
  },

  async [CopilotIntent.RevenueForecast]({ ctx, forecast, openRecs }) {
    const currency = ctx.store.currency;
    const result = await forecast();
    if (result.revenue === null) {
      return {
        headline: `Not enough sales history to forecast yet — the ${ForecastMethod.RevenueWeeklySeasonalityV1} method needs at least 14 full days, and ${Math.min(ctx.revenue.daily.length, 14)} are available.`,
        bullets: [
          "Forecasting activates automatically once the window fills — nothing to configure.",
          `Current ${ctx.revenue.windowDays}-day run rate: ${formatMoney(Math.round((ctx.revenue.netCents / Math.max(1, ctx.revenue.daily.length)) * 14), currency)} every 14 days (simple average, no seasonality model).`,
        ],
        tables: [],
        recommendationRefs: [],
        method: ForecastMethod.RevenueWeeklySeasonalityV1,
        confidence: 20,
      };
    }
    const revenue = result.revenue;
    return {
      headline: `Next ${revenue.horizonDays} days: ${formatMoney(revenue.totalExpectedCents, currency)} expected (range ${formatMoney(revenue.totalLowCents, currency)}–${formatMoney(revenue.totalHighCents, currency)}).`,
      bullets: [
        `Method ${ForecastMethod.RevenueWeeklySeasonalityV1}: weekly seasonality + linear trend over the last ${revenue.windowDays} days (fit R² ${revenue.fitR2}).`,
        `Trend contribution: ${formatMoney(revenue.trendCentsPerDay, currency)}/day.`,
        "Bands widen with distance — treat them as planning ranges, not guarantees.",
      ],
      tables: [
        {
          title: `Daily projection — next ${revenue.horizonDays} days`,
          columns: ["Date", "Expected", "Low", "High"],
          rows: revenue.points.map((point) => [
            point.date,
            formatMoney(point.expectedCents, currency),
            formatMoney(point.lowCents, currency),
            formatMoney(point.highCents, currency),
          ]),
        },
      ],
      recommendationRefs: openRecs,
      method: ForecastMethod.RevenueWeeklySeasonalityV1,
      confidence: Math.min(90, Math.round(35 + revenue.windowDays * 1.2 + revenue.fitR2 * 15)),
    };
  },

  async [CopilotIntent.RestockWhat]({ ctx, forecast, openRecs }) {
    const currency = ctx.store.currency;
    const result = await forecast();
    const stockouts = result.stockouts;
    const urgent = stockouts.filter((row) => row.coverDays !== null && row.coverDays <= 7);
    return {
      headline:
        stockouts.length === 0
          ? "Nothing at stockout risk — no product with recent sales is projected to run out within the horizon."
          : `${stockouts.length} product${stockouts.length === 1 ? "" : "s"} will run out within ${COPILOT_HORIZON_DAYS}-day cover (${urgent.length} within 7 days).`,
      bullets:
        stockouts.length === 0
          ? [
              `Tracked inventory: ${ctx.inventory.trackedVariants} variants · ${ctx.inventory.lowStock} low-stock · ${ctx.inventory.outOfStock} out of stock right now.`,
              `Method ${ForecastMethod.StockoutVelocityV1}: cover = units on hand ÷ blended sales velocity.`,
            ]
          : [
              `Method ${ForecastMethod.StockoutVelocityV1}: cover = on-hand ÷ velocity (60% last 14d / 40% last 30d).`,
              "Order by cover date — the top rows lose sales first.",
            ],
      tables:
        stockouts.length === 0
          ? []
          : [
              {
                title: "Stockout watchlist",
                columns: ["Product", "On hand", "Velocity/day", "Cover (days)", "Stockout date"],
                rows: stockouts.map((row) => [
                  row.title,
                  String(row.onHand),
                  row.velocityPerDay.toFixed(2),
                  row.coverDays === null ? "no sales" : row.coverDays.toFixed(1),
                  row.stockoutDate ?? "—",
                ]),
              },
            ],
      recommendationRefs: openRecs,
      method: ForecastMethod.StockoutVelocityV1,
      confidence: stockouts.length === 0 ? 70 : 85,
    };
  },

  async [CopilotIntent.VipCustomers]({ ctx, openRecs }) {
    const currency = ctx.store.currency;
    const vips = ctx.customers.vip;
    return {
      headline:
        vips.length === 0
          ? "No VIP segment yet — VIPs appear once customers reach repeat-order lifetime value."
          : `${vips.length} VIP customers drive your highest lifetime value.`,
      bullets: [
        `Customer base: ${ctx.customers.total} total · ${ctx.customers.newLastWindow} new in the last ${ctx.revenue.windowDays} days.`,
        ...(vips.length > 0
          ? [`Top VIP lifetime value: ${formatMoney(vips[0]!.ltvCents, currency)} (${vips[0]!.firstName ?? "Customer"}, ${vips[0]!.ordersCount} orders).`]
          : []),
      ],
      tables:
        vips.length === 0
          ? []
          : [
              {
                title: "VIP customers",
                columns: ["Customer", "Lifetime value", "Orders", "Last order"],
                rows: vips.slice(0, 10).map((customer) => [
                  customer.firstName ?? "Customer",
                  formatMoney(customer.ltvCents, currency),
                  String(customer.ordersCount),
                  customer.daysSinceLastOrder === null ? "—" : `${customer.daysSinceLastOrder}d ago`,
                ]),
              },
            ],
      recommendationRefs: openRecs,
      method: "context.v1",
      confidence: dataConfidence(ctx.revenue.daily.length, vips.length > 0),
    };
  },

  async [CopilotIntent.ProductsDying]({ ctx, openRecs }) {
    const currency = ctx.store.currency;
    const dead = ctx.products.deadStock;
    const parkedCents = dead.reduce((sum, product) => sum + product.onHand * product.priceCents, 0);
    return {
      headline:
        dead.length === 0
          ? "No dying products — everything with stock on hand has sold within the last 30 days."
          : `${dead.length} products stopped selling — ${formatMoney(parkedCents, currency)} of capital is parked on shelves.`,
      bullets: [
        "Rule: zero units sold in 30 days while carrying 10+ units of stock.",
        ...(dead.length > 0 ? ["A clearance incentive converts a documented fraction of parked value — see the open action below."] : []),
      ],
      tables:
        dead.length === 0
          ? []
          : [
              {
                title: "Dead stock",
                columns: ["Product", "On hand", "Listed", "Unit price"],
                rows: dead.slice(0, 10).map((product) => [
                  product.title,
                  String(product.onHand),
                  `${product.daysListed}d`,
                  formatMoney(product.priceCents, currency),
                ]),
              },
            ],
      recommendationRefs: openRecs,
      method: "context.v1",
      confidence: dataConfidence(ctx.revenue.daily.length, ctx.customers.total > 0),
    };
  },

  async [CopilotIntent.DiscountSuggestion]({ ctx, openRecs }) {
    const currency = ctx.store.currency;
    const firings = evaluateRules(ctx).filter(
      (firing) =>
        firing.actionType === ActionType.CreateDiscountCode ||
        Number(firing.executionTemplate["discountPercent"] ?? 0) > 0,
    );
    const suggestions = firings.map((firing) => {
      const percent = Number(firing.executionTemplate["discountPercent"] ?? 0);
      return {
        title: firing.type,
        percent,
        estimatedRevenueCents: firing.estimatedRevenueCents,
        estimatedCostCents: firing.estimatedCostCents,
        facts: firing.facts,
        ruleId: firing.ruleId,
      };
    });
    return {
      headline:
        suggestions.length === 0
          ? "No discount opportunity qualifies right now — incentives fire only on real triggers (dead stock, win-backs, VIP moments), never calendar gimmicks."
          : `${suggestions.length} discount ${suggestions.length === 1 ? "opportunity qualifies" : "opportunities qualify"} based on current store data.`,
      bullets: suggestions.flatMap((suggestion) => suggestion.facts.slice(0, 2)),
      tables:
        suggestions.length === 0
          ? []
          : [
              {
                title: "Incentive options (advisory)",
                columns: ["Action", "Discount", "Expected upside", "Incentive cost"],
                rows: suggestions.map((suggestion) => [
                  suggestion.title,
                  `${suggestion.percent}%`,
                  formatMoney(suggestion.estimatedRevenueCents, currency),
                  formatMoney(suggestion.estimatedCostCents, currency),
                ]),
              },
            ],
      recommendationRefs: openRecs,
      method: "rules.v1",
      confidence: dataConfidence(ctx.revenue.daily.length, ctx.customers.total > 0),
    };
  },

  async [CopilotIntent.RevenueSummary]({ ctx, openRecs }) {
    const currency = ctx.store.currency;
    const daily = ctx.revenue.daily;
    return {
      headline: `Last ${ctx.revenue.windowDays} days: ${formatMoney(ctx.revenue.netCents, currency)} net across ${ctx.revenue.ordersCount} orders (${pct(ctx.revenue.trendPct)} vs the previous window).`,
      bullets: [
        `Gross ${formatMoney(ctx.revenue.grossCents, currency)} · discounts ${formatMoney(ctx.revenue.discountsCents, currency)} · refunds ${formatMoney(ctx.revenue.refundsCents, currency)}.`,
        `Average order value: ${formatMoney(ctx.revenue.aovCents, currency)}.`,
        `Cancelled orders: ${ctx.revenue.cancelledCount}.`,
      ],
      tables: [
        {
          title: `Daily net sales — last ${Math.min(14, daily.length)} days`,
          columns: ["Date", "Net sales", "Orders"],
          rows: daily.slice(-14).map((day) => [day.date, formatMoney(day.netCents, currency), String(day.orders)]),
        },
      ],
      recommendationRefs: openRecs,
      method: "context.v1",
      confidence: dataConfidence(daily.length, ctx.customers.total > 0),
    };
  },

  async [CopilotIntent.ChurnRisks]({ ctx, forecast, openRecs }) {
    const result = await forecast();
    const risks = result.churnRisks;
    const currency = ctx.store.currency;
    const valueAtRisk = risks.reduce((sum, row) => sum + row.totalSpentCents, 0);
    return {
      headline:
        risks.length === 0
          ? "No churn risks right now — every repeat customer is ordering within their usual cadence."
          : `${risks.length} repeat customers are overdue on their purchase cadence (${formatMoney(valueAtRisk, currency)} lifetime value at risk).`,
      bullets: [
        "Method: RFM cadence score — actual silence ÷ the customer's own average order interval (deterministic, no ML).",
        ...(risks.length > 0 ? ["A win-back message to the top of this list protects the most lifetime value per send."] : []),
      ],
      tables:
        risks.length === 0
          ? []
          : [
              {
                title: "Churn risks",
                columns: ["Customer", "Risk", "Orders", "Lifetime value", "Silent for"],
                rows: risks.map((row) => [
                  row.name ?? "Customer",
                  `${row.riskScore}/100`,
                  String(row.ordersCount),
                  formatMoney(row.totalSpentCents, currency),
                  `${row.daysSinceLastOrder}d`,
                ]),
              },
            ],
      recommendationRefs: openRecs,
      method: "context.v1",
      confidence: risks.length === 0 ? 65 : 85,
    };
  },

  async [CopilotIntent.BusinessSummary]({ ctx, forecast, openRecs }) {
    const currency = ctx.store.currency;
    const result = await forecast();
    const stockoutCount = result.stockouts.filter((row) => row.coverDays !== null && row.coverDays <= COPILOT_HORIZON_DAYS).length;
    return {
      headline: `${ctx.store.name}: ${formatMoney(ctx.revenue.netCents, currency)} net over ${ctx.revenue.windowDays} days (${pct(ctx.revenue.trendPct)}), ${ctx.customers.total} customers, ${openRecs.length} open actions.`,
      bullets: [
        `Revenue: ${formatMoney(ctx.revenue.netCents, currency)} net · AOV ${formatMoney(ctx.revenue.aovCents, currency)} · refunds at ${ctx.refunds.ratePct}% of sales value.`,
        `Customers: ${ctx.customers.total} total · ${ctx.customers.newLastWindow} new · ${ctx.customers.vip.length} VIPs · ${result.churnRisks.length} churn risks.`,
        `Inventory: ${ctx.inventory.trackedVariants} variants tracked · ${stockoutCount} stockout risk${stockoutCount === 1 ? "" : "s"} within ${COPILOT_HORIZON_DAYS} days.`,
        result.revenue !== null
          ? `Forecast (${ForecastMethod.RevenueWeeklySeasonalityV1}): ${formatMoney(result.revenue.totalExpectedCents, currency)} expected over the next ${result.revenue.horizonDays} days.`
          : "Forecast: awaiting 14 days of sales history.",
        `Recovery: ${formatMoney(ctx.checkouts.abandonedValueCents, currency)} sitting in ${ctx.checkouts.abandonedCount} abandoned carts.`,
      ],
      tables:
        ctx.products.topByRevenue.length === 0
          ? []
          : [
              {
                title: `Top products — last ${ctx.revenue.windowDays} days`,
                columns: ["Product", "Revenue", "Units"],
                rows: ctx.products.topByRevenue.slice(0, 5).map((product) => [
                  product.title,
                  formatMoney(product.revenueCents, currency),
                  String(product.units),
                ]),
              },
            ],
      recommendationRefs: openRecs,
      method: "context.v1",
      confidence: dataConfidence(ctx.revenue.daily.length, ctx.customers.total > 0),
    };
  },

  async [CopilotIntent.GeneralOther]({ ctx }) {
    return {
      headline: "I answer from your store's real numbers — ask about sales, forecasts, stock, customers, or incentives.",
      bullets: [
        "\"Why are my sales down?\" — revenue trajectory with the week-by-week trail.",
        "\"What should I restock?\" — stockout watchlist with cover days.",
        "\"Forecast next week's revenue\" — method-stamped projection with honest ranges.",
        "\"Who are my best customers?\" / \"Who is about to churn?\" — segments from the RFM cadence score.",
        "\"Which products are dying?\" / \"Should I run a discount?\" — assortment and incentive truth.",
        "\"Give me a business summary\" — the full picture in one answer.",
      ],
      tables: [],
      recommendationRefs: [],
      method: "none",
      confidence: 100,
    };
  },
};

async function listOpenRecommendations(
  db: ProfitDb,
  storeId: string,
  types: readonly RecommendationTypeValue[],
): Promise<RecommendationRef[]> {
  if (types.length === 0) return [];
  return withStoreScope(db, storeId, async (tx) => {
    const rows = await tx
      .select({
        id: recommendations.id,
        title: recommendations.title,
        type: recommendations.type,
      })
      .from(recommendations)
      .where(
        and(
          eq(recommendations.storeId, storeId),
          eq(recommendations.status, RecommendationStatus.PendingApproval),
          inArray(recommendations.type, [...types]),
        ),
      )
      .orderBy(desc(recommendations.createdAt))
      .limit(6);
    return rows;
  });
}

/**
 * Gather the deterministic evidence bundle for a classified question.
 * One context build + (when the intent needs it) one forecast read — both
 * RLS-scoped to the tenant.
 */
export async function gatherEvidence(
  db: ProfitDb,
  storeId: string,
  classification: IntentClassification,
  now: Date,
  forecastService: ForecastService = new ForecastService(db),
): Promise<CopilotEvidence> {
  const ctx = await buildBusinessContext(db, storeId, now);
  let forecastCache: StoreForecastDto | null = null;
  const inputs: IntentInputs = {
    ctx,
    forecast: async () => {
      forecastCache ??= await forecastService.storeForecast(storeId, COPILOT_HORIZON_DAYS, now);
      return forecastCache;
    },
    openRecs: await listOpenRecommendations(db, storeId, recTypesForIntent(classification.intent)),
  };
  const built = await intentBuilders[classification.intent](inputs);
  return {
    intent: classification.intent,
    matchedPattern: classification.matchedPattern,
    ...built,
    currency: ctx.store.currency,
    windowLabel: `${ctx.window.from} → ${ctx.window.to}`,
  };
}
