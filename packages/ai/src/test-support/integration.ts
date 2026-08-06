import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfitDb } from "@profit/db";
import {
  customerMetrics,
  dailyMetrics,
  revenueMetrics,
  shopifyCheckouts,
  shopifyCustomers,
  stores,
  storeSettings,
} from "@profit/db";
import { createTestDatabase, type TestDatabase } from "@profit/db/testing";
import { StoreStatus } from "@profit/types";

/**
 * Shared PGlite fixtures for the decision-plane integration suites — REAL
 * migrations 0000→0005 (incl. RLS on the AI tables), owner-role seeding,
 * exactly like the notifications/worker suites.
 */

const here = dirname(fileURLToPath(import.meta.url));

export async function bootAiTestDb(): Promise<TestDatabase> {
  return createTestDatabase(resolve(here, "../../../db/drizzle"));
}

export async function seedStore(
  db: ProfitDb,
  input: {
    shopDomain: string;
    automation?: Record<string, unknown>;
    name?: string;
  },
): Promise<string> {
  const rows = await db
    .insert(stores)
    .values({
      shopDomain: input.shopDomain,
      name: input.name ?? "AI Store",
      status: StoreStatus.Active,
    })
    .returning();
  const id = rows[0]!.id;
  await db.insert(storeSettings).values({
    storeId: id,
    aiPreferences: {},
    automationPreferences: input.automation ?? {},
    featureOverrides: {},
    branding: {},
  });
  return id;
}

/** 30 days of revenue + order volume (rich data — passes calibration dampeners). */
export async function seedAnalytics(
  db: ProfitDb,
  storeId: string,
  options: { ordersPerDay?: number; netPerDayCents?: number } = {},
): Promise<void> {
  const orders = options.ordersPerDay ?? 4;
  const net = options.netPerDayCents ?? 20_000;
  const rows: (typeof dailyMetrics.$inferInsert)[] = [];
  const revRows: (typeof revenueMetrics.$inferInsert)[] = [];
  for (let i = 1; i <= 30; i += 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    rows.push({
      storeId,
      metricDate: day,
      ordersCount: orders,
      cancelledOrders: 0,
      itemsSold: orders * 2,
      newCustomers: 1,
      returningCustomers: 2,
      aovCents: Math.round(net / orders),
    });
    revRows.push({
      storeId,
      metricDate: day,
      grossSalesCents: net,
      discountsCents: 500,
      refundsCents: 0,
      netSalesCents: net,
      taxesCents: 0,
      shippingCents: 0,
      currency: "USD",
    });
  }
  await db.insert(dailyMetrics).values(rows);
  await db.insert(revenueMetrics).values(revRows);
}

export async function seedCustomers(
  db: ProfitDb,
  storeId: string,
  specs: readonly {
    shopifyId: string;
    email: string | null;
    firstName?: string;
    acceptsMarketing?: boolean;
    orders?: number;
    spent?: string;
    /** When present, the analytics-plane customer_metrics row is written too (VIP/inactive/at-risk segments). */
    metrics?: { orders: number; spentCents: number; lastOrderDaysAgo: number };
  }[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const spec of specs) {
    const rows = await db
      .insert(shopifyCustomers)
      .values({
        storeId,
        shopifyCustomerId: spec.shopifyId,
        email: spec.email,
        firstName: spec.firstName ?? null,
        ordersCount: spec.orders ?? 0,
        totalSpent: spec.spent ?? "0.00",
        acceptsMarketing: spec.acceptsMarketing ?? false,
        shopifyCreatedAt: new Date(Date.now() - 200 * 86_400_000),
      })
      .returning();
    const customerId = rows[0]!.id;
    if (spec.metrics !== undefined) {
      const lastOrderAt = new Date(Date.now() - spec.metrics.lastOrderDaysAgo * 86_400_000);
      await db.insert(customerMetrics).values({
        storeId,
        customerId,
        ordersCount: spec.metrics.orders,
        totalSpentCents: spec.metrics.spentCents,
        aovCents: Math.round(spec.metrics.spentCents / Math.max(1, spec.metrics.orders)),
        firstOrderAt: new Date(Date.now() - 200 * 86_400_000),
        lastOrderAt,
      });
    }
    map.set(spec.shopifyId, customerId);
  }
  return map;
}

export async function seedCheckout(
  db: ProfitDb,
  storeId: string,
  input: {
    token: string;
    email: string | null;
    total?: string;
    hoursAgo?: number;
    customerId?: string | null;
    completed?: boolean;
  },
): Promise<void> {
  await db.insert(shopifyCheckouts).values({
    storeId,
    shopifyCheckoutId: `chk-${input.token}`,
    token: input.token,
    email: input.email,
    customerId: input.customerId ?? null,
    totalPrice: input.total ?? "96.00",
    currency: "USD",
    webUrl: `https://checkout.example/recover/${input.token}`,
    lineItems: [{ title: "Alpha Runner", quantity: 1, price: "96.00" }],
    completedAt: input.completed === true ? new Date() : null,
    shopifyCreatedAt: new Date(Date.now() - (input.hoursAgo ?? 9) * 3_600_000),
    shopifyUpdatedAt: new Date(Date.now() - (input.hoursAgo ?? 9) * 3_600_000),
  });
}
