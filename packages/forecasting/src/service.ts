import { and, desc, eq, gte, isNotNull, ne, sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  customerMetrics,
  dailyMetrics,
  productMetrics,
  revenueMetrics,
  shopifyCustomers,
  shopifyInventoryLevels,
  shopifyProducts,
  shopifyProductVariants,
  withStoreScope,
} from "@profit/db";
import { ForecastMethod } from "@profit/types";
import {
  churnRiskScore,
  daysOfCover,
  forecastDemand,
  forecastRevenue,
  type DailyForecastPoint,
  type RevenueForecastResult,
} from "./methods";

/**
 * Store-facing deterministic forecasting (M8, ADR 33). Reads ONLY the M2
 * precomputed aggregates + mirror inventory/customer snapshots through the
 * RLS-scoped transaction — dashboards/copilot/reports all consume the same
 * read model, so an answer and a printed report can never disagree.
 */

export interface ProductDemandDto {
  readonly productId: string;
  readonly title: string;
  readonly velocityPerDay: number;
  readonly expectedUnits: number;
  readonly unitsLast30d: number;
}

export interface StockoutDto extends ProductDemandDto {
  readonly onHand: number;
  /** Days of cover (0 = empty); null never disguised as a date. */
  readonly coverDays: number | null;
  /** UTC date of expected stockout when computable. */
  readonly stockoutDate: string | null;
}

export interface ChurnRiskDto {
  readonly customerId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly ordersCount: number;
  readonly totalSpentCents: number;
  readonly daysSinceLastOrder: number;
  readonly riskScore: number;
}

export interface StoreForecastDto {
  readonly computedAt: string;
  readonly revenueMethod: string;
  readonly demandMethod: string;
  readonly horizonDays: number;
  /** null when history is too short (MIN_WINDOW_DAYS) — never faked. */
  readonly revenue: RevenueForecastResult | null;
  readonly topDemand: readonly ProductDemandDto[];
  readonly stockouts: readonly StockoutDto[];
  readonly churnRisks: readonly ChurnRiskDto[];
}

const TOP_N = 10;

function utcDateIso(daysOffsetFromToday: number, now: Date): string {
  const date = new Date(now.getTime() + daysOffsetFromToday * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export class ForecastService {
  constructor(private readonly db: ProfitDb) {}

  async revenueHistory(storeId: string, windowDays: number, now: Date): Promise<readonly { date: string; valueCents: number }[]> {
    const from = utcDateIso(-windowDays, now);
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          date: revenueMetrics.metricDate,
          valueCents: revenueMetrics.netSalesCents,
        })
        .from(revenueMetrics)
        .where(and(eq(revenueMetrics.storeId, storeId), gte(revenueMetrics.metricDate, from)))
        .orderBy(revenueMetrics.metricDate);
      return rows.map((row) => ({ date: row.date, valueCents: row.valueCents }));
    });
  }

  /** Daily-orders merge for the reporting plane (same window as revenue). */
  async dailyOrders(storeId: string, windowDays: number, now: Date): Promise<readonly { date: string; orders: number; newCustomers: number }[]> {
    const from = utcDateIso(-windowDays, now);
    return withStoreScope(this.db, storeId, async (tx) => {
      return tx
        .select({
          date: dailyMetrics.metricDate,
          orders: dailyMetrics.ordersCount,
          newCustomers: dailyMetrics.newCustomers,
        })
        .from(dailyMetrics)
        .where(and(eq(dailyMetrics.storeId, storeId), gte(dailyMetrics.metricDate, from)))
        .orderBy(dailyMetrics.metricDate);
    });
  }

  async storeForecast(storeId: string, horizonDays: number, now: Date): Promise<StoreForecastDto> {
    const todayIso = utcDateIso(0, now);
    const [history, demandRows, stockRows, churnRows] = await Promise.all([
      this.revenueHistory(storeId, 56, now),
      this.demandInputs(storeId, now),
      this.stockInputs(storeId, now),
      this.churnInputs(storeId, now),
    ]);
    const inputs = this.compose(storeId, horizonDays, todayIso, now, history, demandRows, stockRows, churnRows);
    return inputs;
  }

  compose(
    _storeId: string,
    horizonDays: number,
    todayIso: string,
    now: Date,
    history: readonly { date: string; valueCents: number }[],
    demandRows: readonly { productId: string; title: string; units14: number; units30: number }[],
    stockRows: readonly { productId: string; title: string; units14: number; units30: number; onHand: number }[],
    churnRows: readonly { customerId: string; email: string | null; name: string | null; ordersCount: number; totalSpentCents: number; firstOrderAt: Date; lastOrderAt: Date }[],
  ): StoreForecastDto {
    const demand: ProductDemandDto[] = demandRows
      .map((row) => ({ ...forecastDemand(row.units14, row.units30, horizonDays), productId: row.productId, title: row.title, unitsLast30d: row.units30 }))
      .sort((a, b) => b.expectedUnits - a.expectedUnits)
      .slice(0, TOP_N);

    const stockouts: StockoutDto[] = stockRows
      .map((row) => {
        const { velocityPerDay, expectedUnits } = forecastDemand(row.units14, row.units30, horizonDays);
        const cover = daysOfCover(row.onHand, velocityPerDay);
        return {
          productId: row.productId,
          title: row.title,
          velocityPerDay,
          expectedUnits,
          unitsLast30d: row.units30,
          onHand: row.onHand,
          coverDays: cover,
          stockoutDate:
            cover !== null ? (cover === 0 ? todayIso : utcDateIso(Math.ceil(cover), now)) : null,
        };
      })
      .filter((row) => row.onHand === 0 || row.coverDays !== null)
      .sort((a, b) => (a.coverDays ?? 0) - (b.coverDays ?? 0))
      .slice(0, TOP_N);

    const churnRisks: ChurnRiskDto[] = churnRows
      .map((row) => ({
        customerId: row.customerId,
        email: row.email,
        name: row.name,
        ordersCount: row.ordersCount,
        totalSpentCents: row.totalSpentCents,
        daysSinceLastOrder: Math.round((now.getTime() - row.lastOrderAt.getTime()) / 86_400_000),
        riskScore: churnRiskScore(row.firstOrderAt, row.lastOrderAt, row.ordersCount, now.getTime()),
      }))
      .filter((row) => row.riskScore >= 40)
      .sort((a, b) => b.riskScore - a.riskScore || b.totalSpentCents - a.totalSpentCents)
      .slice(0, TOP_N);

    return {
      computedAt: now.toISOString(),
      revenueMethod: ForecastMethod.RevenueWeeklySeasonalityV1,
      demandMethod: ForecastMethod.DemandVelocityV1,
      horizonDays,
      revenue: forecastRevenue(history, horizonDays, todayIso),
      topDemand: demand,
      stockouts,
      churnRisks,
    };
  }

  private async demandInputs(storeId: string, now: Date) {
    const from14 = utcDateIso(-14, now);
    const from30 = utcDateIso(-30, now);
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          productId: productMetrics.productId,
          title: shopifyProducts.title,
          units14: sql<number>`coalesce(sum(case when ${productMetrics.metricDate} >= ${from14} then ${productMetrics.unitsSold} else 0 end), 0)`,
          units30: sql<number>`coalesce(sum(case when ${productMetrics.metricDate} >= ${from30} then ${productMetrics.unitsSold} else 0 end), 0)`,
        })
        .from(productMetrics)
        .innerJoin(shopifyProducts, eq(shopifyProducts.id, productMetrics.productId))
        .where(and(eq(productMetrics.storeId, storeId), gte(productMetrics.metricDate, from30)))
        .groupBy(productMetrics.productId, shopifyProducts.title);
      return rows;
    });
  }

  private async stockInputs(storeId: string, now: Date) {
    const demand = await this.demandInputs(storeId, now);
    return withStoreScope(this.db, storeId, async (tx) => {
      const onHandRows = await tx
        .select({
          productId: shopifyProductVariants.productId,
          onHand: sql<number>`coalesce(sum(${shopifyInventoryLevels.available}), 0)`,
        })
        .from(shopifyProductVariants)
        .innerJoin(
          shopifyInventoryLevels,
          eq(shopifyInventoryLevels.inventoryItemId, shopifyProductVariants.inventoryItemId),
        )
        .where(
          and(
            eq(shopifyProductVariants.storeId, storeId),
            isNotNull(shopifyProductVariants.inventoryItemId),
          ),
        )
        .groupBy(shopifyProductVariants.productId);
      const onHandByProduct = new Map(onHandRows.map((row) => [row.productId, row.onHand]));
      return demand
        .filter((row) => onHandByProduct.has(row.productId))
        .map((row) => ({ ...row, onHand: onHandByProduct.get(row.productId) ?? 0 }));
    });
  }

  private async churnInputs(storeId: string, now: Date) {
    const cutoff = new Date(now.getTime() - 180 * 86_400_000);
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          customerId: customerMetrics.customerId,
          email: shopifyCustomers.email,
          name: shopifyCustomers.firstName,
          ordersCount: customerMetrics.ordersCount,
          totalSpentCents: customerMetrics.totalSpentCents,
          firstOrderAt: customerMetrics.firstOrderAt,
          lastOrderAt: customerMetrics.lastOrderAt,
        })
        .from(customerMetrics)
        .innerJoin(shopifyCustomers, eq(shopifyCustomers.id, customerMetrics.customerId))
        .where(
          and(
            eq(customerMetrics.storeId, storeId),
            ne(customerMetrics.ordersCount, 0),
            isNotNull(customerMetrics.firstOrderAt),
            isNotNull(customerMetrics.lastOrderAt),
            gte(customerMetrics.lastOrderAt, cutoff),
          ),
        )
        .orderBy(desc(customerMetrics.totalSpentCents))
        .limit(400);
      // isNotNull is a runtime guarantee; narrow the type for compose().
      return rows.filter(
        (row): row is (typeof row & { firstOrderAt: Date; lastOrderAt: Date }) =>
          row.firstOrderAt !== null && row.lastOrderAt !== null,
      );
    });
  }
}
