import { sql as drizzleSql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { execRaw, withStoreScope } from "@profit/db";

/**
 * Analytics aggregation (P2: daily_metrics / product_metrics / customer_metrics
 * / revenue_metrics). One rule governs everything here: recomputation is
 * SET-BASED and IDEMPOTENT — for any date range, re-running converges to the
 * same rows because aggregates derive from the source of truth (orders/line
 * items), never from the previous aggregate. That makes webhook-triggered
 * incremental refreshes and nightly full recomputes equally safe.
 *
 * Money: cents via round(numeric * 100) — exact decimal math in SQL, no
 * floating-point drift. Buckets: UTC dates of processed_at in M2 (store-
 * timezone bucketing is a documented reporting-milestone follow-up).
 * Test orders never contribute; cancelled orders stay visible via
 * cancelled_orders but earn no revenue/units.
 */

export type AggregationWindow =
  | { readonly kind: "all" }
  | { readonly kind: "range"; readonly dateFrom: string; readonly dateTo: string };

function dateBounds(window: AggregationWindow) {
  if (window.kind === "all") {
    return { from: "1970-01-01", to: "2999-12-31" };
  }
  return { from: window.dateFrom, to: window.dateTo };
}

async function aggregateDailyAndRevenue(
  tx: ProfitDb,
  storeId: string,
  window: AggregationWindow,
): Promise<void> {
  const { from, to } = dateBounds(window);
  // daily_metrics — operational counts
  await tx.execute(drizzleSql`
    WITH scoped_orders AS (
      SELECT
        o.id, o.customer_id, o.subtotal_price, o.total_price, o.cancelled_at,
        (o.processed_at AT TIME ZONE 'UTC')::date AS bucket
      FROM shopify_orders o
      WHERE o.store_id = ${storeId}
        AND o.processed_at IS NOT NULL
        AND NOT o.is_test
        AND (o.processed_at AT TIME ZONE 'UTC')::date BETWEEN ${from}::date AND ${to}::date
    ),
    customer_firsts AS (
      SELECT customer_id, MIN((processed_at AT TIME ZONE 'UTC')::date) AS first_bucket
      FROM shopify_orders
      WHERE store_id = ${storeId} AND processed_at IS NOT NULL AND NOT is_test
        AND customer_id IS NOT NULL
      GROUP BY customer_id
    ),
    items AS (
      SELECT (o.processed_at AT TIME ZONE 'UTC')::date AS bucket, SUM(li.quantity) AS qty
      FROM shopify_order_line_items li
      JOIN shopify_orders o ON o.id = li.order_id
      WHERE li.store_id = ${storeId} AND o.processed_at IS NOT NULL AND NOT o.is_test
        AND o.cancelled_at IS NULL
        AND (o.processed_at AT TIME ZONE 'UTC')::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1
    )
    INSERT INTO daily_metrics (
      store_id, metric_date, orders_count, cancelled_orders, items_sold,
      new_customers, returning_customers, aov_cents
    )
    SELECT
      ${storeId}::uuid,
      s.bucket,
      COUNT(*) FILTER (WHERE s.cancelled_at IS NULL)::int,
      COUNT(*) FILTER (WHERE s.cancelled_at IS NOT NULL)::int,
      COALESCE(items.qty, 0)::int,
      COUNT(*) FILTER (
        WHERE s.cancelled_at IS NULL AND s.customer_id IS NOT NULL
          AND f.first_bucket = s.bucket
      )::int,
      COUNT(*) FILTER (
        WHERE s.cancelled_at IS NULL AND s.customer_id IS NOT NULL
          AND f.first_bucket < s.bucket
      )::int,
      COALESCE(
        ROUND(AVG(s.subtotal_price) FILTER (WHERE s.cancelled_at IS NULL) * 100),
        0
      )::int
    FROM scoped_orders s
    LEFT JOIN customer_firsts f ON f.customer_id = s.customer_id
    LEFT JOIN items ON items.bucket = s.bucket
    GROUP BY s.bucket, items.qty
    ON CONFLICT (store_id, metric_date) DO UPDATE SET
      orders_count = EXCLUDED.orders_count,
      cancelled_orders = EXCLUDED.cancelled_orders,
      items_sold = EXCLUDED.items_sold,
      new_customers = EXCLUDED.new_customers,
      returning_customers = EXCLUDED.returning_customers,
      aov_cents = EXCLUDED.aov_cents,
      updated_at = now()
  `);

  // revenue_metrics — money line (exact cents)
  await tx.execute(drizzleSql`
    INSERT INTO revenue_metrics (
      store_id, metric_date, gross_sales_cents, discounts_cents, refunds_cents,
      net_sales_cents, taxes_cents, shipping_cents, currency
    )
    SELECT
      ${storeId}::uuid,
      (o.processed_at AT TIME ZONE 'UTC')::date AS bucket,
      ROUND(SUM(o.subtotal_price + o.total_discounts) * 100)::bigint,
      ROUND(SUM(o.total_discounts) * 100)::bigint,
      ROUND(SUM(o.total_refunded) * 100)::bigint,
      ROUND(SUM(o.subtotal_price - o.total_refunded) * 100)::bigint,
      ROUND(SUM(o.total_tax) * 100)::bigint,
      ROUND(SUM(o.total_shipping) * 100)::bigint,
      MAX(o.currency)
    FROM shopify_orders o
    WHERE o.store_id = ${storeId}
      AND o.processed_at IS NOT NULL
      AND NOT o.is_test
      AND o.cancelled_at IS NULL
      AND (o.processed_at AT TIME ZONE 'UTC')::date BETWEEN ${from}::date AND ${to}::date
    GROUP BY bucket
    ON CONFLICT (store_id, metric_date) DO UPDATE SET
      gross_sales_cents = EXCLUDED.gross_sales_cents,
      discounts_cents = EXCLUDED.discounts_cents,
      refunds_cents = EXCLUDED.refunds_cents,
      net_sales_cents = EXCLUDED.net_sales_cents,
      taxes_cents = EXCLUDED.taxes_cents,
      shipping_cents = EXCLUDED.shipping_cents,
      currency = EXCLUDED.currency,
      updated_at = now()
  `);
}

async function aggregateProductMetrics(
  tx: ProfitDb,
  storeId: string,
  window: AggregationWindow,
): Promise<void> {
  const { from, to } = dateBounds(window);
  await tx.execute(drizzleSql`
    INSERT INTO product_metrics (
      store_id, product_id, metric_date, units_sold, orders_count, revenue_cents
    )
    SELECT
      ${storeId}::uuid,
      li.product_id,
      (o.processed_at AT TIME ZONE 'UTC')::date AS bucket,
      SUM(li.quantity)::int,
      COUNT(DISTINCT o.id)::int,
      ROUND(SUM((li.price * li.quantity) - li.total_discount) * 100)::bigint
    FROM shopify_order_line_items li
    JOIN shopify_orders o ON o.id = li.order_id
    WHERE li.store_id = ${storeId}
      AND li.product_id IS NOT NULL
      AND o.processed_at IS NOT NULL
      AND NOT o.is_test
      AND o.cancelled_at IS NULL
      AND (o.processed_at AT TIME ZONE 'UTC')::date BETWEEN ${from}::date AND ${to}::date
    GROUP BY li.product_id, bucket
    ON CONFLICT (store_id, product_id, metric_date) DO UPDATE SET
      units_sold = EXCLUDED.units_sold,
      orders_count = EXCLUDED.orders_count,
      revenue_cents = EXCLUDED.revenue_cents,
      updated_at = now()
  `);
}

async function aggregateCustomerMetrics(
  tx: ProfitDb,
  storeId: string,
): Promise<void> {
  // Lifetime snapshots always recompute across full history — partial windows
  // would corrupt "lifetime" semantics.
  await tx.execute(drizzleSql`
    INSERT INTO customer_metrics (
      store_id, customer_id, orders_count, total_spent_cents, aov_cents,
      first_order_at, last_order_at, last_computed_at
    )
    SELECT
      ${storeId}::uuid,
      o.customer_id,
      COUNT(*)::int,
      ROUND(SUM(o.subtotal_price) * 100)::bigint,
      COALESCE(ROUND(AVG(o.subtotal_price) * 100), 0)::int,
      MIN(o.processed_at),
      MAX(o.processed_at),
      now()
    FROM shopify_orders o
    WHERE o.store_id = ${storeId}
      AND o.customer_id IS NOT NULL
      AND o.processed_at IS NOT NULL
      AND NOT o.is_test
      AND o.cancelled_at IS NULL
    GROUP BY o.customer_id
    ON CONFLICT (store_id, customer_id) DO UPDATE SET
      orders_count = EXCLUDED.orders_count,
      total_spent_cents = EXCLUDED.total_spent_cents,
      aov_cents = EXCLUDED.aov_cents,
      first_order_at = EXCLUDED.first_order_at,
      last_order_at = EXCLUDED.last_order_at,
      last_computed_at = EXCLUDED.last_computed_at,
      updated_at = now()
  `);
}

export interface AnalyticsRefreshResult {
  readonly dailyUpserted: number;
  readonly durationMs: number;
}

/** Recompute all four aggregates for one store, optionally scoped to a date window. */
export async function refreshAnalytics(
  db: ProfitDb,
  storeId: string,
  window: AggregationWindow = { kind: "all" },
): Promise<AnalyticsRefreshResult> {
  const startedAt = Date.now();
  await withStoreScope(db, storeId, async (tx) => {
    // Per-store serialization: concurrent refreshes (webhook bursts, fan-in +
    // nightly overlapping) would otherwise commit stale snapshots in
    // nondeterministic order. The xact lock orders writers; READ COMMITTED
    // then guarantees the LAST lock holder computes from the freshest data,
    // so final rows always converge to complete.
    await tx.execute(drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${storeId}))`);
    await aggregateDailyAndRevenue(tx, storeId, window);
    await aggregateProductMetrics(tx, storeId, window);
    await aggregateCustomerMetrics(tx, storeId);
  });
  const readBack = await execRaw<{ count: string }>(
    db,
    drizzleSql`SELECT COUNT(*) AS count FROM daily_metrics WHERE store_id = ${storeId}::uuid`,
  );
  return {
    dailyUpserted: Number(readBack[0]?.count ?? 0),
    durationMs: Date.now() - startedAt,
  };
}

/** Normalize a webhook-provided date list into the smallest covering window. */
export function windowForDates(dates: readonly string[]): AggregationWindow {
  if (dates.length === 0) return { kind: "all" };
  const sorted = [...dates].sort();
  return { kind: "range", dateFrom: sorted[0] ?? dates[0]!, dateTo: sorted[sorted.length - 1] ?? dates[0]! };
}
