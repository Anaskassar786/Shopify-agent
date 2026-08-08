import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfitDb } from "@profit/db";
import {
  customerMetrics,
  productMetrics,
  revenueMetrics,
  shopifyCustomers,
  shopifyInventoryLevels,
  shopifyLocations,
  shopifyProducts,
  shopifyProductVariants,
  stores,
} from "@profit/db";
import { createTestDatabase, type TestDatabase } from "@profit/db/testing";
import { ForecastMethod, StoreStatus } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  churnRiskScore,
  daysOfCover,
  forecastDemand,
  forecastRevenue,
  type DailyPoint,
} from "./methods";
import { ForecastService } from "./service";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-08-08T12:00:00.000Z");

function iso(daysBefore: number): string {
  return new Date(NOW.getTime() - daysBefore * 86_400_000).toISOString().slice(0, 10);
}

/* ── Pure-method behavior (hand-computable expectations) ──────────────────── */

describe("forecast methods (deterministic math, ADR 33)", () => {
  it("weekly-seasonality: flat series reproduces the level, bands are symmetric and widen", () => {
    const daily: DailyPoint[] = Array.from({ length: 28 }, (_, i) => ({
      date: iso(28 - i),
      valueCents: 10_000,
    }));
    const result = forecastRevenue(daily, 7, iso(0));
    expect(result).not.toBeNull();
    expect(result!.windowDays).toBe(28);
    expect(result!.trendCentsPerDay).toBe(0);
    expect(result!.totalExpectedCents).toBe(70_000);
    const first = result!.points[0]!;
    const last = result!.points[6]!;
    expect(first.lowCents).toBeLessThanOrEqual(first.expectedCents);
    expect(first.highCents).toBeGreaterThanOrEqual(first.expectedCents);
    // Widen-with-distance: the far horizon must be at least as uncertain.
    expect(last.highCents - last.expectedCents).toBeGreaterThanOrEqual(
      first.highCents - first.expectedCents,
    );
    expect(result!.fitR2).toBe(1);
  });

  it("weekly-seasonality: Saturday spikes persist in the same weekday offsets", () => {
    const daily: DailyPoint[] = Array.from({ length: 56 }, (_, i) => {
      const date = iso(56 - i);
      const saturday = new Date(`${date}T00:00:00.000Z`).getUTCDay() === 6;
      return { date, valueCents: saturday ? 20_000 : 8_000 };
    });
    const result = forecastRevenue(daily, 7, iso(0))!;
    const saturdayPoint = result.points.find(
      (point) => new Date(`${point.date}T00:00:00.000Z`).getUTCDay() === 6,
    );
    const weekdayPoints = result.points.filter(
      (point) => new Date(`${point.date}T00:00:00.000Z`).getUTCDay() !== 6,
    );
    expect(saturdayPoint!.expectedCents).toBeGreaterThan(
      Math.max(...weekdayPoints.map((point) => point.expectedCents)),
    );
  });

  it("refuses thin windows instead of inventing confidence", () => {
    const daily: DailyPoint[] = Array.from({ length: 10 }, (_, i) => ({
      date: iso(10 - i),
      valueCents: 5_000,
    }));
    expect(forecastRevenue(daily, 14, iso(0))).toBeNull();
  });

  it("demand blend: 60% recent / 40% trailing, floors at zero", () => {
    // units14 = 84 (6/day), units30 = 116 ⇒ velocity = 0.6*6 + 0.4*(116/30)
    const { velocityPerDay, expectedUnits } = forecastDemand(84, 116, 30);
    expect(velocityPerDay).toBeCloseTo(5.1467, 3);
    expect(expectedUnits).toBe(154.4);
    expect(forecastDemand(0, 0, 30).velocityPerDay).toBe(0);
  });

  it("days of cover: honest edges (empty ⇒ 0, no velocity ⇒ null)", () => {
    expect(daysOfCover(0, 5)).toBe(0);
    expect(daysOfCover(50, 0)).toBeNull();
    expect(daysOfCover(50, 5)).toBe(10);
  });

  it("churn RFM score: in-cadence ⇒ 0, 4× late ⇒ 100", () => {
    const first = new Date("2026-01-01T00:00:00.000Z");
    const lastInCadence = new Date("2026-08-01T00:00:00.000Z"); // interval ~30d, last order 7d ago
    expect(churnRiskScore(first, lastInCadence, 8, NOW.getTime())).toBe(0);
    const churned = new Date("2026-04-01T00:00:00.000Z"); // interval ~21d, 129d since
    const score = churnRiskScore(first, churned, 5, NOW.getTime());
    expect(score).toBe(100);
  });
});

/* ── Read-model integration (real migrations + RLS seed) ──────────────────── */

let testDb: TestDatabase;
let db: ProfitDb;
let storeA: string;
let storeB: string;
let productA1: string;
let productB: string;

async function seedStore(domain: string, name: string): Promise<string> {
  const rows = await db
    .insert(stores)
    .values({ shopDomain: domain, name, status: StoreStatus.Active })
    .returning();
  return rows[0]!.id;
}

async function seedProduct(storeId: string, key: string, title: string): Promise<string> {
  const productRows = await db
    .insert(shopifyProducts)
    .values({ storeId, shopifyProductId: key, title, status: "ACTIVE" })
    .returning();
  return productRows[0]!.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase(resolve(here, "../../db/drizzle"));
  db = testDb.db;
  storeA = await seedStore("forecast-a.myshopify.com", "Forecast A");
  storeB = await seedStore("forecast-b.myshopify.com", "Forecast B");

  productA1 = await seedProduct(storeA, "fa-1", "Copper Kettle");
  const productA2 = await seedProduct(storeA, "fa-2", "Brass Ladle");
  productB = await seedProduct(storeB, "fb-1", "Copper Kettle"); // same title, other tenant

  const locationRows = await db
    .insert(shopifyLocations)
    .values({ storeId: storeA, shopifyLocationId: "loc-a", name: "Main" })
    .returning();
  const locationA = locationRows[0]!.id;
  const locationRowsB = await db
    .insert(shopifyLocations)
    .values({ storeId: storeB, shopifyLocationId: "loc-b", name: "Main" })
    .returning();
  const locationB = locationRowsB[0]!.id;

  const variantRows = await db
    .insert(shopifyProductVariants)
    .values([
      { storeId: storeA, productId: productA1, shopifyVariantId: "fa-1-v1", inventoryItemId: "iem-a1", sku: "CK-1" },
      { storeId: storeA, productId: productA2, shopifyVariantId: "fa-2-v1", inventoryItemId: "iem-a2", sku: "BL-1" },
      { storeId: storeB, productId: productB, shopifyVariantId: "fb-1-v1", inventoryItemId: "iem-b1", sku: "CK-9" },
    ])
    .returning();
  expect(variantRows).toHaveLength(3);

  await db.insert(shopifyInventoryLevels).values([
    { storeId: storeA, inventoryItemId: "iem-a1", locationId: locationA, available: 50 },
    { storeId: storeA, inventoryItemId: "iem-a2", locationId: locationA, available: 0 },
    { storeId: storeB, inventoryItemId: "iem-b1", locationId: locationB, available: 500 },
  ]);

  // Revenue: A flat 10_000/day for 28d; B flat 5_000/day (isolation marker).
  await db.insert(revenueMetrics).values(
    Array.from({ length: 28 }, (_, i) => ({
      storeId: storeA,
      metricDate: iso(28 - i),
      netSalesCents: 10_000,
      grossSalesCents: 12_000,
    })),
  );
  await db.insert(revenueMetrics).values(
    Array.from({ length: 28 }, (_, i) => ({
      storeId: storeB,
      metricDate: iso(28 - i),
      netSalesCents: 5_000,
      grossSalesCents: 6_000,
    })),
  );

  // Product metrics A1: i=0 is the OLDEST day (iso(30)). 2/day for the oldest
  // 16 days, 6/day across the most recent 14 ⇒ units14 = 84, units30 = 116.
  await db.insert(productMetrics).values(
    Array.from({ length: 30 }, (_, i) => ({
      storeId: storeA,
      productId: productA1,
      metricDate: iso(30 - i),
      unitsSold: i >= 16 ? 6 : 2,
      revenueCents: 0,
    })),
  );
  // A2: small recent sale 10 days ago, now an empty shelf (stockout by
  // definition: demand signal exists, cover = 0).
  await db.insert(productMetrics).values([
    { storeId: storeA, productId: productA2, metricDate: iso(10), unitsSold: 2, revenueCents: 0 },
    { storeId: storeB, productId: productB, metricDate: iso(5), unitsSold: 9, revenueCents: 0 },
  ]);

  // Customers: one in-cadence, one churning (A); one churning (B).
  const custRows = await db
    .insert(shopifyCustomers)
    .values([
      { storeId: storeA, shopifyCustomerId: "ca-1", email: "steady@example.com", firstName: "Steady" },
      { storeId: storeA, shopifyCustomerId: "ca-2", email: "fading@example.com", firstName: "Fading" },
      { storeId: storeB, shopifyCustomerId: "cb-1", email: "fading-b@example.com", firstName: "FadingBee" },
    ])
    .returning();
  const [steady, fading, fadingB] = custRows as [typeof custRows[0], typeof custRows[0], typeof custRows[0]];
  await db.insert(customerMetrics).values([
    {
      storeId: storeA,
      customerId: steady.id,
      ordersCount: 8,
      totalSpentCents: 400_000,
      firstOrderAt: new Date("2026-01-01T00:00:00.000Z"),
      lastOrderAt: new Date("2026-08-03T00:00:00.000Z"),
    },
    {
      storeId: storeA,
      customerId: fading.id,
      ordersCount: 5,
      totalSpentCents: 900_000,
      firstOrderAt: new Date("2026-01-01T00:00:00.000Z"),
      lastOrderAt: new Date("2026-04-01T00:00:00.000Z"),
    },
    {
      storeId: storeB,
      customerId: fadingB.id,
      ordersCount: 5,
      totalSpentCents: 900_000,
      firstOrderAt: new Date("2026-01-01T00:00:00.000Z"),
      lastOrderAt: new Date("2026-04-01T00:00:00.000Z"),
    },
  ]);
}, 120_000);

afterAll(async () => {
  await testDb.close();
});

describe("ForecastService.storeForecast (deterministic read model)", () => {
  it("reproduces the seeded level, methods stamped, bands honest", async () => {
    const service = new ForecastService(db);
    const forecast = await service.storeForecast(storeA, 7, NOW);
    expect(forecast.revenueMethod).toBe(ForecastMethod.RevenueWeeklySeasonalityV1);
    expect(forecast.demandMethod).toBe(ForecastMethod.DemandVelocityV1);
    expect(forecast.revenue).not.toBeNull();
    expect(forecast.revenue!.totalExpectedCents).toBe(70_000);
    expect(forecast.revenue!.windowDays).toBe(28);
    expect(forecast.revenue!.totalLowCents).toBeLessThanOrEqual(forecast.revenue!.totalExpectedCents);
    expect(forecast.revenue!.totalHighCents).toBeGreaterThanOrEqual(forecast.revenue!.totalExpectedCents);
  });

  it("demand uses the blended velocity; empty-shelf product leads stockouts", async () => {
    const service = new ForecastService(db);
    const forecast = await service.storeForecast(storeA, 30, NOW);
    const kettle = forecast.topDemand.find((row) => row.productId === productA1);
    expect(kettle).toBeDefined();
    expect(kettle!.velocityPerDay).toBeCloseTo(5.1467, 3);
    expect(kettle!.expectedUnits).toBe(154.4);

    const ladle = forecast.stockouts.find((row) => row.title === "Brass Ladle");
    expect(ladle).toBeDefined();
    expect(ladle!.onHand).toBe(0);
    expect(ladle!.coverDays).toBe(0);
    expect(ladle!.stockoutDate).toBe(iso(0));

    const kettleStock = forecast.stockouts.find((row) => row.productId === productA1);
    expect(kettleStock).toBeDefined();
    expect(kettleStock!.coverDays).toBeCloseTo(9.7, 1); // 50 / 5.1467
  });

  it("churn risks rank the fading spender first; in-cadence customer is absent", async () => {
    const service = new ForecastService(db);
    const forecast = await service.storeForecast(storeA, 30, NOW);
    expect(forecast.churnRisks).toHaveLength(1);
    expect(forecast.churnRisks[0]!.email).toBe("fading@example.com");
    expect(forecast.churnRisks[0]!.riskScore).toBe(100);
    expect(forecast.churnRisks.map((row) => row.email)).not.toContain("steady@example.com");
  });

  it("tenant isolation: B reads only B numbers, even with a same-titled product", async () => {
    const service = new ForecastService(db);
    const forecastB = await service.storeForecast(storeB, 7, NOW);
    expect(forecastB.revenue!.totalExpectedCents).toBe(35_000);
    expect(forecastB.topDemand.find((row) => row.title === "Copper Kettle")!.productId).toBe(productB);
    expect(forecastB.churnRisks.map((row) => row.email)).toEqual(["fading-b@example.com"]);
  });

  it("thin history yields revenue:null while demand/stockout answers stay live", async () => {
    const fresh = await seedStore("forecast-empty.myshopify.com", "Forecast Empty");
    const service = new ForecastService(db);
    const forecast = await service.storeForecast(fresh, 14, NOW);
    expect(forecast.revenue).toBeNull();
    expect(forecast.topDemand).toHaveLength(0);
  });
});
