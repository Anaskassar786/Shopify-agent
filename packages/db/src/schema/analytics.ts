import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./_common";
import { stores } from "./merchant";
import { shopifyCustomers, shopifyProducts } from "./shopify-data";

/**
 * Analytics plane (PART 2: daily_metrics / product_metrics / customer_metrics /
 * revenue_metrics). Precomputed, set-based rollups over the Shopify data
 * plane — dashboards read HERE, never by scanning transactional tables.
 *
 * Two rules make this pipeline trustworthy:
 *  1. Recomputation is always set-based and idempotent (INSERT … ON CONFLICT
 *     DO UPDATE) — re-running for any date range converges to the same numbers;
 *  2. Money is integer cents (bigint mode number) — float drift is impossible.
 *
 * day bucketing is UTC in M2; store-timezone bucketing ships with the reporting
 * milestone (documented follow-up in M2 docs).
 */

export const dailyMetrics = pgTable(
  "daily_metrics",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    metricDate: date("metric_date", { mode: "string" }).notNull(),
    ordersCount: integer("orders_count").notNull().default(0),
    cancelledOrders: integer("cancelled_orders").notNull().default(0),
    itemsSold: integer("items_sold").notNull().default(0),
    newCustomers: integer("new_customers").notNull().default(0),
    returningCustomers: integer("returning_customers").notNull().default(0),
    aovCents: integer("aov_cents").notNull().default(0),
  },
  (table) => [
    uniqueIndex("daily_metrics_store_date_unique").on(table.storeId, table.metricDate),
    index("daily_metrics_store_idx").on(table.storeId),
  ],
);

export const revenueMetrics = pgTable(
  "revenue_metrics",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    metricDate: date("metric_date", { mode: "string" }).notNull(),
    grossSalesCents: bigint("gross_sales_cents", { mode: "number" }).notNull().default(0),
    discountsCents: bigint("discounts_cents", { mode: "number" }).notNull().default(0),
    refundsCents: bigint("refunds_cents", { mode: "number" }).notNull().default(0),
    netSalesCents: bigint("net_sales_cents", { mode: "number" }).notNull().default(0),
    taxesCents: bigint("taxes_cents", { mode: "number" }).notNull().default(0),
    shippingCents: bigint("shipping_cents", { mode: "number" }).notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  },
  (table) => [
    uniqueIndex("revenue_metrics_store_date_unique").on(table.storeId, table.metricDate),
    index("revenue_metrics_store_idx").on(table.storeId),
  ],
);

export const productMetrics = pgTable(
  "product_metrics",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => shopifyProducts.id, { onDelete: "cascade" }),
    metricDate: date("metric_date", { mode: "string" }).notNull(),
    unitsSold: integer("units_sold").notNull().default(0),
    ordersCount: integer("orders_count").notNull().default(0),
    revenueCents: bigint("revenue_cents", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    uniqueIndex("product_metrics_store_product_date_unique").on(
      table.storeId,
      table.productId,
      table.metricDate,
    ),
    index("product_metrics_store_date_idx").on(table.storeId, table.metricDate),
  ],
);

/** Per-customer lifetime snapshot (unique(store, customer)) — segmented reads in M4+. */
export const customerMetrics = pgTable(
  "customer_metrics",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => shopifyCustomers.id, { onDelete: "cascade" }),
    ordersCount: integer("orders_count").notNull().default(0),
    totalSpentCents: bigint("total_spent_cents", { mode: "number" }).notNull().default(0),
    aovCents: integer("aov_cents").notNull().default(0),
    firstOrderAt: timestamp("first_order_at", { withTimezone: true, mode: "date" }),
    lastOrderAt: timestamp("last_order_at", { withTimezone: true, mode: "date" }),
    lastComputedAt: timestamp("last_computed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex("customer_metrics_store_customer_unique").on(table.storeId, table.customerId),
  ],
);
