import { and, eq, gte, lt, sql, type ProfitDb } from "@profit/db";
import {
  dailyMetrics,
  productMetrics,
  recommendations,
  revenueMetrics,
  shopifyProducts,
  stores,
  withStoreScope,
} from "@profit/db";
import { formatMoney, type ExecutiveKpiInput } from "@profit/ai";
import { ForecastService } from "@profit/forecasting";
import {
  ReportKind,
  RecommendationStatus,
  type ReportKind as ReportKindValue,
} from "@profit/types";
import {
  periodIsoRange,
  periodLabel,
  priorPeriodFor,
  type ReportPeriod,
} from "./periods";

/**
 * Deterministic report sections (M8, ADR 34): every number comes from the M2
 * aggregates/mirror tables through ONE tenant-scoped unit of work — the PDF,
 * the JSON sections and the executive prose are three renderings of the same
 * computed structure, so they can never disagree.
 */

/** KPI card row shared with the executive composer (label/display/deltaPct). */
export type ReportKpi = ExecutiveKpiInput;

export interface ReportTable {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface ReportForecastBlock {
  readonly method: string;
  readonly horizonDays: number;
  readonly expectedCents: number;
  readonly lowCents: number;
  readonly highCents: number;
  readonly stockoutRisks: number;
  readonly churnRisks: number;
}

export interface ReportActionsLedger {
  readonly createdInPeriod: number;
  readonly executedInPeriod: number;
  readonly openPendingAtEnd: number;
}

export interface ReportSectionsData {
  readonly storeName: string;
  readonly currency: string;
  readonly kind: ReportKindValue;
  readonly periodLabel: string;
  readonly period: { readonly startIso: string; readonly endIsoExclusive: string };
  readonly generatedAt: string;
  readonly headline: string;
  readonly kpis: readonly ReportKpi[];
  readonly highlights: readonly string[];
  readonly performance: ReportTable;
  readonly topProducts: ReportTable | null;
  readonly forecast: ReportForecastBlock | null;
  readonly actions: ReportActionsLedger;
}

interface WindowAggregate {
  readonly netCents: number;
  readonly grossCents: number;
  readonly discountsCents: number;
  readonly refundsCents: number;
  readonly orders: number;
  readonly newCustomers: number;
  readonly cancelled: number;
}

function signedDeltaPct(current: number, prior: number): number | null {
  if (prior <= 0) return null;
  return Math.round(((current - prior) / prior) * 100);
}

interface DailyRow {
  readonly date: string;
  readonly netCents: number;
  readonly orders: number;
  readonly newCustomers: number;
}

function bucketWeekly(rows: readonly DailyRow[]): { label: string; row: DailyRow }[] {
  const buckets: { label: string; row: DailyRow }[] = [];
  for (let i = 0; i < rows.length; i += 7) {
    const slice = rows.slice(i, i + 7);
    const first = slice[0]!;
    const last = slice[slice.length - 1]!;
    buckets.push({
      label: `${first.date} – ${last.date}`,
      row: {
        date: `${first.date} – ${last.date}`,
        netCents: slice.reduce((sum, day) => sum + day.netCents, 0),
        orders: slice.reduce((sum, day) => sum + day.orders, 0),
        newCustomers: slice.reduce((sum, day) => sum + day.newCustomers, 0),
      },
    });
  }
  return buckets;
}

export interface SectionInputs {
  readonly db: ProfitDb;
  readonly forecast: ForecastService;
  readonly storeId: string;
  readonly kind: ReportKindValue;
  readonly period: ReportPeriod;
  readonly now: Date;
}

/** Compose the full deterministic section payload (single scoped unit). */
export async function buildReportSections(input: SectionInputs): Promise<ReportSectionsData> {
  const { db, storeId, kind, period, now } = input;
  const label = periodLabel(kind, period);
  const { from, toExclusive } = periodIsoRange(period);
  const prior = periodIsoRange(priorPeriodFor(period));
  const periodStart = period.start;
  const periodEnd = period.end;

  const queries = await withStoreScope(db, storeId, async (tx) => {
    const storeRows = await tx
      .select({ name: stores.name, currency: stores.currency })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const store = storeRows[0];
    if (store === undefined) throw new Error(`store ${storeId} not found`);

    const revenueAgg = (fromIso: string, toIso: string) =>
      tx
        .select({
          netCents: sql<number>`coalesce(sum(${revenueMetrics.netSalesCents}), 0)`,
          grossCents: sql<number>`coalesce(sum(${revenueMetrics.grossSalesCents}), 0)`,
          discountsCents: sql<number>`coalesce(sum(${revenueMetrics.discountsCents}), 0)`,
          refundsCents: sql<number>`coalesce(sum(${revenueMetrics.refundsCents}), 0)`,
        })
        .from(revenueMetrics)
        .where(
          and(
            eq(revenueMetrics.storeId, storeId),
            gte(revenueMetrics.metricDate, fromIso),
            lt(revenueMetrics.metricDate, toIso),
          ),
        );

    const dailyAgg = (fromIso: string, toIso: string) =>
      tx
        .select({
          orders: sql<number>`coalesce(sum(${dailyMetrics.ordersCount}), 0)`,
          newCustomers: sql<number>`coalesce(sum(${dailyMetrics.newCustomers}), 0)`,
          cancelled: sql<number>`coalesce(sum(${dailyMetrics.cancelledOrders}), 0)`,
        })
        .from(dailyMetrics)
        .where(
          and(
            eq(dailyMetrics.storeId, storeId),
            gte(dailyMetrics.metricDate, fromIso),
            lt(dailyMetrics.metricDate, toIso),
          ),
        );

    const dailyRows = await tx
      .select({
        date: dailyMetrics.metricDate,
        orders: dailyMetrics.ordersCount,
        newCustomers: dailyMetrics.newCustomers,
      })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.storeId, storeId),
          gte(dailyMetrics.metricDate, from),
          lt(dailyMetrics.metricDate, toExclusive),
        ),
      )
      .orderBy(dailyMetrics.metricDate);

    const revenueByDay = await tx
      .select({ date: revenueMetrics.metricDate, netCents: revenueMetrics.netSalesCents })
      .from(revenueMetrics)
      .where(
        and(
          eq(revenueMetrics.storeId, storeId),
          gte(revenueMetrics.metricDate, from),
          lt(revenueMetrics.metricDate, toExclusive),
        ),
      )
      .orderBy(revenueMetrics.metricDate);

    const productAgg = (fromIso: string, toIso: string) =>
      tx
        .select({
          productId: productMetrics.productId,
          title: shopifyProducts.title,
          revenueCents: sql<number>`coalesce(sum(${productMetrics.revenueCents}), 0)`,
          units: sql<number>`coalesce(sum(${productMetrics.unitsSold}), 0)`,
        })
        .from(productMetrics)
        .innerJoin(shopifyProducts, eq(shopifyProducts.id, productMetrics.productId))
        .where(
          and(
            eq(productMetrics.storeId, storeId),
            gte(productMetrics.metricDate, fromIso),
            lt(productMetrics.metricDate, toIso),
          ),
        )
        .groupBy(productMetrics.productId, shopifyProducts.title);

    const actionCounts = await tx
      .select({
        created: sql<number>`count(case when ${recommendations.createdAt} >= ${periodStart} and ${recommendations.createdAt} < ${periodEnd} then 1 end)`,
        executed: sql<number>`count(case when ${recommendations.status} in (${RecommendationStatus.Executed}, ${RecommendationStatus.Measured}) and ${recommendations.updatedAt} >= ${periodStart} and ${recommendations.updatedAt} < ${periodEnd} then 1 end)`,
        openPending: sql<number>`count(case when ${recommendations.status} = ${RecommendationStatus.PendingApproval} then 1 end)`,
      })
      .from(recommendations)
      .where(eq(recommendations.storeId, storeId));

    const [curRev, curDaily, priorRev, priorDaily, curProducts, priorProducts] = await Promise.all([
      revenueAgg(from, toExclusive),
      dailyAgg(from, toExclusive),
      revenueAgg(prior.from, prior.toExclusive),
      dailyAgg(prior.from, prior.toExclusive),
      productAgg(from, toExclusive),
      productAgg(prior.from, prior.toExclusive),
    ]);

    return {
      store,
      current: {
        ...(curRev[0] ?? { netCents: 0, grossCents: 0, discountsCents: 0, refundsCents: 0 }),
        ...(curDaily[0] ?? { orders: 0, newCustomers: 0, cancelled: 0 }),
      } as WindowAggregate,
      priorWindow: {
        ...(priorRev[0] ?? { netCents: 0, grossCents: 0, discountsCents: 0, refundsCents: 0 }),
        ...(priorDaily[0] ?? { orders: 0, newCustomers: 0, cancelled: 0 }),
      } as WindowAggregate,
      dailyRows,
      revenueByDay,
      curProducts,
      priorProducts,
      actionsRow: actionCounts[0] ?? { created: 0, executed: 0, openPending: 0 },
    };
  });

  const { store, current, priorWindow, dailyRows, revenueByDay, curProducts, priorProducts, actionsRow } = queries;
  const currency = store.currency;
  const fmt = (cents: number): string => formatMoney(cents, currency);

  const netByDay = new Map(revenueByDay.map((row) => [row.date, row.netCents]));
  const series: DailyRow[] = dailyRows.map((row) => ({
    date: row.date,
    netCents: netByDay.get(row.date) ?? 0,
    orders: row.orders,
    newCustomers: row.newCustomers,
  }));

  const aov = current.orders > 0 ? Math.round(current.netCents / current.orders) : 0;
  const priorAov = priorWindow.orders > 0 ? Math.round(priorWindow.netCents / priorWindow.orders) : 0;
  const netDelta = signedDeltaPct(current.netCents, priorWindow.netCents);

  const kpis: ReportKpi[] = [
    { label: "Net sales", display: fmt(current.netCents), deltaPct: netDelta },
    { label: "Gross sales", display: fmt(current.grossCents), deltaPct: signedDeltaPct(current.grossCents, priorWindow.grossCents) },
    { label: "Orders", display: String(current.orders), deltaPct: signedDeltaPct(current.orders, priorWindow.orders) },
    { label: "Average order value", display: fmt(aov), deltaPct: signedDeltaPct(aov, priorAov) },
    { label: "Refunds", display: fmt(current.refundsCents), deltaPct: signedDeltaPct(current.refundsCents, priorWindow.refundsCents) },
    { label: "New customers", display: String(current.newCustomers), deltaPct: signedDeltaPct(current.newCustomers, priorWindow.newCustomers) },
  ];

  const performanceRows: DailyRow[] =
    kind === ReportKind.Quarterly ? bucketWeekly(series).map((b) => b.row) : series;
  const performance: ReportTable = {
    title: kind === ReportKind.Quarterly ? "Weekly performance" : "Daily performance",
    columns: [kind === ReportKind.Quarterly ? "Week" : "Date", "Net sales", "Orders", "New customers"],
    rows: performanceRows.map((row) => [row.date, fmt(row.netCents), String(row.orders), String(row.newCustomers)]),
  };

  const priorProductRevenue = new Map(priorProducts.map((row) => [row.productId, row.revenueCents]));
  const topProducts: ReportTable | null =
    curProducts.length === 0
      ? null
      : {
          title: "Top products",
          columns: ["Product", "Revenue", "Units", "Δ vs prior"],
          rows: curProducts
            .sort((a, b) => b.revenueCents - a.revenueCents)
            .slice(0, 10)
            .map((row) => {
              const delta = signedDeltaPct(row.revenueCents, priorProductRevenue.get(row.productId) ?? 0);
              return [row.title, fmt(row.revenueCents), String(row.units), delta === null ? "new" : `${delta > 0 ? "+" : ""}${delta}%`];
            }),
        };

  const forecastResult = await input.forecast.storeForecast(storeId, 14, now);
  const forecast: ReportForecastBlock | null =
    forecastResult.revenue === null
      ? null
      : {
          method: forecastResult.revenueMethod,
          horizonDays: forecastResult.revenue.horizonDays,
          expectedCents: forecastResult.revenue.totalExpectedCents,
          lowCents: forecastResult.revenue.totalLowCents,
          highCents: forecastResult.revenue.totalHighCents,
          stockoutRisks: forecastResult.stockouts.length,
          churnRisks: forecastResult.churnRisks.length,
        };

  const actions: ReportActionsLedger = {
    createdInPeriod: Number(actionsRow.created),
    executedInPeriod: Number(actionsRow.executed),
    openPendingAtEnd: Number(actionsRow.openPending),
  };

  const highlights: string[] = [
    forecast !== null
      ? `${forecast.horizonDays}-day outlook (${forecast.method}): ${fmt(forecast.expectedCents)} expected (range ${fmt(forecast.lowCents)}–${fmt(forecast.highCents)}).`
      : "Forecast: pending — at least 14 days of sales history required before the seasonal model engages.",
    forecastResult.stockouts.length > 0
      ? `${forecastResult.stockouts.length} product${forecastResult.stockouts.length === 1 ? "" : "s"} face stockout within the cover horizon.`
      : "No stockout risk within the cover horizon.",
    forecastResult.churnRisks.length > 0
      ? `${forecastResult.churnRisks.length} repeat customer${forecastResult.churnRisks.length === 1 ? "" : "s"} overdue on their purchase cadence.`
      : "No churn risk — every repeat customer is in cadence.",
    `AI actions: ${actions.createdInPeriod} created, ${actions.executedInPeriod} executed this period, ${actions.openPendingAtEnd} awaiting review.`,
  ];

  return {
    storeName: store.name,
    currency,
    kind,
    periodLabel: label,
    period: { startIso: from, endIsoExclusive: toExclusive },
    generatedAt: now.toISOString(),
    headline:
      `${store.name} — ${kind.toLowerCase()} report · ${label}: net ${fmt(current.netCents)}` +
      (netDelta !== null ? ` (${netDelta > 0 ? "+" : ""}${netDelta}% vs prior)` : ""),
    kpis,
    highlights,
    performance,
    topProducts,
    forecast,
    actions,
  };
}
