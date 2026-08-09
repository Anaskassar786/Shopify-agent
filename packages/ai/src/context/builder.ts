import { sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { eq, execRaw, stores, storeSettings, withStoreScope } from "@profit/db";
import { z } from "zod";
import type {
  AbandonedCheckoutRef,
  AutomationPolicy,
  BusinessContext,
  CustomerRef,
} from "./types";
import { CONTEXT_CAPS } from "./types";

/**
 * Business Context Builder (P10 system flow stage 1). Reads ONLY the M2
 * analytics + data planes inside the tenant RLS scope — the AI sees exactly
 * the same audited numbers the dashboard renders.
 *
 * Every row set is validated with Zod at the SQL boundary: a drifted column
 * type fails the run loudly (typed error), never silently distorts prompts.
 */

export const CONTEXT_WINDOW_DAYS = 30 as const;

const cents = (numericString: string | null | undefined): number => {
  if (numericString === null || numericString === undefined || numericString === "") return 0;
  // Exact decimal → cents without float drift: parse via string math.
  const negative = numericString.startsWith("-");
  const [wholeRaw, fracRaw = ""] = numericString.replace("-", "").split(".");
  const whole = Number(wholeRaw) || 0;
  const frac = Number((fracRaw + "00").slice(0, 2)) || 0;
  const value = whole * 100 + frac;
  return negative ? -value : value;
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgoIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/* ── Row contracts at the SQL boundary ───────────────────────────────────── */

const revenueWindowRow = z.object({
  gross_cents: z.coerce.number(),
  net_cents: z.coerce.number(),
  discounts_cents: z.coerce.number(),
  refunds_cents: z.coerce.number(),
});

const dailyRow = z.object({
  metric_date: z.string(),
  net_cents: z.coerce.number(),
  orders_count: z.coerce.number(),
});

const customerRow = z.object({
  id: z.string().uuid(),
  first_name: z.string().nullable(),
  ltv_cents: z.coerce.number(),
  orders_count: z.coerce.number(),
  last_order_at: z.coerce.date().nullable(),
});

const productSalesRow = z.object({
  id: z.string().uuid(),
  title: z.string(),
  price_cents: z.coerce.number(),
  revenue_cents: z.coerce.number(),
  units: z.coerce.number(),
});

const stockRow = z.object({
  id: z.string().uuid(),
  title: z.string(),
  price_cents: z.coerce.number(),
  on_hand: z.coerce.number(),
  units: z.coerce.number(),
  age_days: z.coerce.number(),
});

const inventorySummaryRow = z.object({
  variants: z.coerce.number(),
  out_of_stock: z.coerce.number(),
});

const checkoutRow = z.object({
  token: z.string(),
  customer_id: z.string().uuid().nullable(),
  first_name: z.string().nullable(),
  email: z.string().nullable(),
  total_price: z.string(),
  currency: z.string(),
  line_items: z.unknown(),
  web_url: z.string().nullable(),
  created_at: z.coerce.date(),
});

const memoryRow = z.object({
  generated_total: z.coerce.number(),
  accepted_total: z.coerce.number(),
  rejected_total: z.coerce.number(),
  attributed_cents: z.coerce.number(),
  attributed_orders: z.coerce.number(),
});

const lineItemPreview = z
  .object({ title: z.string(), quantity: z.coerce.number() })
  .passthrough();

/* ── Automation policy (merchant-authored guardrails) ────────────────────── */

export const automationPolicySchema = z.object({
  mode: z.enum(["MANUAL", "SEMI_AUTOMATIC", "FULLY_AUTOMATIC"]).default("MANUAL"),
  abandonedCart: z
    .object({
      enabled: z.boolean().default(true),
      delayHours: z.number().int().min(1).max(72).default(6),
      minCartValueCents: z.number().int().min(0).default(0),
      discountPercent: z.number().int().min(0).max(50).default(10),
    })
    .default({ enabled: true, delayHours: 6, minCartValueCents: 0, discountPercent: 10 }),
  autopilot: z
    .object({
      maxDiscountPercent: z.number().int().min(5).max(50).default(20),
      maxEstimatedRevenueCents: z.number().int().min(0).default(100_000),
    })
    .default({ maxDiscountPercent: 20, maxEstimatedRevenueCents: 100_000 }),
});

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  mode: "MANUAL",
  abandonedCartEnabled: true,
  abandonedCartDelayHours: 6,
  abandonedCartMinValueCents: 0,
  abandonedCartDiscountPercent: 10,
  maxAutoDiscountPercent: 20,
  maxAutoApproveEstimatedRevenueCents: 100_000,
};

export function parseAutomationPolicy(raw: unknown): AutomationPolicy {
  const parsed = automationPolicySchema.safeParse(raw ?? {});
  if (!parsed.success) return DEFAULT_AUTOMATION_POLICY;
  return {
    mode: parsed.data.mode,
    abandonedCartEnabled: parsed.data.abandonedCart.enabled,
    abandonedCartDelayHours: parsed.data.abandonedCart.delayHours,
    abandonedCartMinValueCents: parsed.data.abandonedCart.minCartValueCents,
    abandonedCartDiscountPercent: parsed.data.abandonedCart.discountPercent,
    maxAutoDiscountPercent: parsed.data.autopilot.maxDiscountPercent,
    maxAutoApproveEstimatedRevenueCents: parsed.data.autopilot.maxEstimatedRevenueCents,
  };
}

/* ── Builder ─────────────────────────────────────────────────────────────── */

function mapCustomer(row: z.infer<typeof customerRow>, now: Date): CustomerRef {
  return {
    id: row.id,
    firstName: row.first_name,
    ltvCents: row.ltv_cents,
    ordersCount: row.orders_count,
    lastOrderAt: row.last_order_at?.toISOString() ?? null,
    daysSinceLastOrder:
      row.last_order_at === null
        ? null
        : Math.floor((now.getTime() - row.last_order_at.getTime()) / 86_400_000),
  };
}

export async function buildBusinessContext(
  db: ProfitDb,
  storeId: string,
  now: Date = new Date(),
): Promise<BusinessContext> {
  const windowDays = CONTEXT_WINDOW_DAYS;
  const fromDay = isoDay(new Date(now.getTime() - windowDays * 86_400_000));
  const priorFromDay = isoDay(new Date(now.getTime() - 2 * windowDays * 86_400_000));
  const toDay = isoDay(now);

  const storeRows = await db
    .select({ name: stores.name, currency: stores.currency, timezone: stores.timezone })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  const store = storeRows[0];
  if (store === undefined) throw new Error(`store ${storeId} not found for context build`);

  const settingsRows = await db
    .select({ automationPreferences: storeSettings.automationPreferences })
    .from(storeSettings)
    .where(eq(storeSettings.storeId, storeId))
    .limit(1);
  const policy = parseAutomationPolicy(settingsRows[0]?.automationPreferences);

  return withStoreScope(db, storeId, async (tx) => {
    const [
      windowRev,
      priorRev,
      daily,
      customerTotals,
      newCustomers,
      vipRows,
      inactiveRows,
      atRiskRows,
      topRows,
      stockRows,
      inventorySummaryRows,
      checkoutRows,
      refundedOrders,
      memoryRows,
    ] = await Promise.all([
      execRaw<unknown>(
        tx,
        sql`SELECT COALESCE(SUM(gross_sales_cents),0) AS gross_cents,
                   COALESCE(SUM(net_sales_cents),0) AS net_cents,
                   COALESCE(SUM(discounts_cents),0) AS discounts_cents,
                   COALESCE(SUM(refunds_cents),0) AS refunds_cents
            FROM revenue_metrics
            WHERE store_id = ${storeId} AND metric_date >= ${fromDay} AND metric_date <= ${toDay}`,
      ),
      execRaw<unknown>(
        tx,
        sql`SELECT COALESCE(SUM(net_sales_cents),0) AS net_cents, 0::bigint AS gross_cents,
                   0::bigint AS discounts_cents, 0::bigint AS refunds_cents
            FROM revenue_metrics
            WHERE store_id = ${storeId} AND metric_date >= ${priorFromDay} AND metric_date < ${fromDay}`,
      ),
      execRaw<unknown>(
        tx,
        sql`SELECT r.metric_date, r.net_sales_cents AS net_cents,
                   COALESCE(d.orders_count, 0) AS orders_count
            FROM revenue_metrics r
            LEFT JOIN daily_metrics d
              ON d.store_id = r.store_id AND d.metric_date = r.metric_date
            WHERE r.store_id = ${storeId} AND r.metric_date >= ${fromDay} AND r.metric_date <= ${toDay}
            ORDER BY r.metric_date ASC
            LIMIT ${CONTEXT_CAPS.dailySeries}`,
      ),
      execRaw<{ total: string }>(
        tx,
        sql`SELECT COUNT(*)::text AS total FROM shopify_customers WHERE store_id = ${storeId}`,
      ),
      execRaw<{ total: string }>(
        tx,
        sql`SELECT COUNT(*)::text AS total FROM shopify_customers
            WHERE store_id = ${storeId} AND shopify_created_at >= ${daysAgoIso(now, windowDays)}`,
      ),
      execRaw<unknown>(
        tx,
        sql`SELECT c.id, c.first_name, m.total_spent_cents AS ltv_cents, m.orders_count, m.last_order_at
            FROM customer_metrics m JOIN shopify_customers c ON c.id = m.customer_id
            WHERE m.store_id = ${storeId} AND m.orders_count >= 2 AND c.email IS NOT NULL
            ORDER BY m.total_spent_cents DESC LIMIT ${CONTEXT_CAPS.vip}`,
      ),
      // Inactive: ordered before, quiet 60–180 days (win-back window, P3 segmentation).
      execRaw<unknown>(
        tx,
        sql`SELECT c.id, c.first_name, m.total_spent_cents AS ltv_cents, m.orders_count, m.last_order_at
            FROM customer_metrics m JOIN shopify_customers c ON c.id = m.customer_id
            WHERE m.store_id = ${storeId} AND m.orders_count >= 2 AND c.email IS NOT NULL
              AND m.last_order_at < ${daysAgoIso(now, 60)}::timestamptz
              AND m.last_order_at >= ${daysAgoIso(now, 180)}::timestamptz
            ORDER BY m.total_spent_cents DESC LIMIT ${CONTEXT_CAPS.inactive}`,
      ),
      // At-risk: ordered before, 30–60 days quiet (early churn signal).
      execRaw<unknown>(
        tx,
        sql`SELECT c.id, c.first_name, m.total_spent_cents AS ltv_cents, m.orders_count, m.last_order_at
            FROM customer_metrics m JOIN shopify_customers c ON c.id = m.customer_id
            WHERE m.store_id = ${storeId} AND m.orders_count >= 2 AND c.email IS NOT NULL
              AND m.last_order_at < ${daysAgoIso(now, 30)}::timestamptz
              AND m.last_order_at >= ${daysAgoIso(now, 60)}::timestamptz
            ORDER BY m.total_spent_cents DESC LIMIT ${CONTEXT_CAPS.atRisk}`,
      ),
      execRaw<unknown>(
        tx,
        sql`SELECT p.id, p.title,
                   COALESCE(MIN(v.price)::numeric, 0::numeric) * 100 AS price_cents,
                   COALESCE(SUM(m.revenue_cents), 0)::bigint AS revenue_cents,
                   COALESCE(SUM(m.units_sold), 0)::bigint AS units
            FROM product_metrics m
            JOIN shopify_products p ON p.id = m.product_id
            LEFT JOIN shopify_product_variants v ON v.product_id = p.id
            WHERE m.store_id = ${storeId} AND m.metric_date >= ${fromDay}
            GROUP BY p.id, p.title
            ORDER BY revenue_cents DESC LIMIT ${CONTEXT_CAPS.topProducts}`,
      ),
      // Stock pressure: per-product on-hand vs 30d velocity (product-level truth).
      execRaw<unknown>(
        tx,
        sql`SELECT p.id, p.title,
                   COALESCE(MIN(v.price)::numeric, 0::numeric) * 100 AS price_cents,
                   COALESCE(SUM(il.available), 0)::bigint AS on_hand,
                   COALESCE(SUM(m.units_sold), 0)::bigint AS units,
                   GREATEST(EXTRACT(DAY FROM (now() - p.shopify_created_at))::int, 1) AS age_days
            FROM shopify_products p
            LEFT JOIN shopify_product_variants v ON v.product_id = p.id
            LEFT JOIN shopify_inventory_levels il ON il.inventory_item_id = v.inventory_item_id
            LEFT JOIN product_metrics m
              ON m.product_id = p.id AND m.metric_date >= ${fromDay} AND m.store_id = ${storeId}
            WHERE p.store_id = ${storeId} AND p.status = 'ACTIVE'
            GROUP BY p.id, p.title, p.shopify_created_at`,
      ),
      execRaw<unknown>(
        tx,
        sql`SELECT COUNT(DISTINCT v.id)::bigint AS variants,
                   COALESCE(SUM(CASE WHEN x.on_hand <= 0 THEN 1 ELSE 0 END), 0)::bigint AS out_of_stock
            FROM shopify_product_variants v
            LEFT JOIN LATERAL (
              SELECT SUM(il.available) AS on_hand
              FROM shopify_inventory_levels il
              WHERE il.inventory_item_id = v.inventory_item_id
            ) x ON true
            WHERE v.store_id = ${storeId}`,
      ),
      // Abandoned checkouts: not completed, no linked order, within 30d.
      execRaw<unknown>(
        tx,
        sql`SELECT ch.token, ch.customer_id, cust.first_name, ch.email, ch.total_price, ch.currency,
                   ch.line_items, ch.web_url, ch.shopify_created_at AS created_at
            FROM shopify_checkouts ch
            LEFT JOIN shopify_customers cust ON cust.id = ch.customer_id
            WHERE ch.store_id = ${storeId}
              AND ch.completed_at IS NULL
              AND ch.shopify_created_at >= ${daysAgoIso(now, windowDays)}::timestamptz
              AND NOT EXISTS (
                SELECT 1 FROM shopify_orders o
                WHERE o.store_id = ${storeId} AND o.checkout_token = ch.token
              )
            ORDER BY ch.total_price DESC LIMIT ${CONTEXT_CAPS.abandoned}`,
      ),
      execRaw<{ total: string }>(
        tx,
        sql`SELECT COUNT(*)::text AS total FROM shopify_orders
            WHERE store_id = ${storeId} AND total_refunded::numeric > 0
              AND processed_at >= ${daysAgoIso(now, windowDays)}::timestamptz`,
      ),
      // Learning loop inputs (P3 feedback): past acceptance + realized attribution.
      execRaw<unknown>(
        tx,
        sql`SELECT COUNT(*)::bigint AS generated_total,
                   COUNT(*) FILTER (WHERE status IN ('APPROVED','SCHEDULED','EXECUTING','EXECUTED','MEASURED'))::bigint AS accepted_total,
                   COUNT(*) FILTER (WHERE status = 'REJECTED')::bigint AS rejected_total,
                   COALESCE((SELECT SUM(attributed_revenue_cents) FROM recommendation_outcomes WHERE store_id = ${storeId}), 0)::bigint AS attributed_cents,
                   COALESCE((SELECT SUM(attributed_orders_count) FROM recommendation_outcomes WHERE store_id = ${storeId}), 0)::bigint AS attributed_orders
            FROM recommendations WHERE store_id = ${storeId}`,
      ),
    ]);

    const windowFallback = { gross_cents: 0, net_cents: 0, discounts_cents: 0, refunds_cents: 0 };
    const win = revenueWindowRow.parse(windowRev[0] ?? windowFallback);
    const prior = revenueWindowRow.parse(priorRev[0] ?? windowFallback);
    const dailyParsed = z.array(dailyRow).parse(daily);
    const memory = memoryRow.parse({
      generated_total: 0, accepted_total: 0, rejected_total: 0, attributed_cents: 0, attributed_orders: 0,
      ...(memoryRows[0] ?? {}),
    });

    const stockParsed = z.array(stockRow).parse(stockRows);
    const velocityPerDay = (units: number): number => units / windowDays;
    const lowStock = stockParsed
      .filter((row) => row.units > 0 && row.on_hand / velocityPerDay(row.units) < 14)
      .sort((a, b) => a.on_hand / velocityPerDay(a.units) - b.on_hand / velocityPerDay(b.units))
      .slice(0, CONTEXT_CAPS.lowStock)
      .map((row) => ({
        id: row.id,
        title: row.title,
        priceCents: Math.round(row.price_cents),
        onHand: row.on_hand,
        velocityPerDay: Number(velocityPerDay(row.units).toFixed(2)),
        daysOfStock: Math.max(Math.floor(row.on_hand / velocityPerDay(row.units)), 0),
      }));
    const deadStock = stockParsed
      .filter((row) => row.units === 0 && row.on_hand >= 10 && row.age_days > 60)
      .sort((a, b) => b.on_hand * b.price_cents - a.on_hand * a.price_cents)
      .slice(0, CONTEXT_CAPS.deadStock)
      .map((row) => ({
        id: row.id,
        title: row.title,
        priceCents: Math.round(row.price_cents),
        onHand: row.on_hand,
        unitsSoldInWindow: 0,
        daysListed: row.age_days,
      }));

    const checkouts: AbandonedCheckoutRef[] = z
      .array(checkoutRow)
      .parse(checkoutRows)
      .map((row) => {
        const items = z.array(lineItemPreview).safeParse(row.line_items);
        const preview = items.success ? items.data : [];
        const createdAt = row.created_at;
        return {
          token: row.token,
          customerId: row.customer_id,
          firstName: row.first_name,
          hasEmail: row.email !== null && row.email !== "",
          totalCents: cents(row.total_price),
          currency: row.currency,
          itemCount: preview.reduce((sum, item) => sum + item.quantity, 0) || preview.length,
          itemsPreview: preview.slice(0, 3).map((item) => ({ title: item.title, quantity: item.quantity })),
          webUrl: row.web_url,
          createdAt: createdAt.toISOString(),
          hoursAgo: Math.max(Math.floor((now.getTime() - createdAt.getTime()) / 3_600_000), 0),
        };
      });

    const ordersCount = dailyParsed.reduce((sum, day) => sum + day.orders_count, 0);
    const aovCents = ordersCount > 0 ? Math.round(win.net_cents / ordersCount) : 0;
    const trendPct =
      prior.net_cents > 0
        ? Math.round(((win.net_cents - prior.net_cents) / prior.net_cents) * 100)
        : null;
    const refundsRatePct =
      win.gross_cents > 0 ? Math.round((win.refunds_cents / win.gross_cents) * 100) : 0;
    const inventorySummary = inventorySummaryRow.parse({
      variants: 0,
      out_of_stock: 0,
      ...(inventorySummaryRows[0] ?? {}),
    });

    return {
      store: {
        id: storeId,
        name: store.name,
        currency: store.currency,
        countryCode: null,
      },
      window: { daysAnalyzed: windowDays, from: fromDay, to: toDay },
      revenue: {
        windowDays,
        netCents: win.net_cents,
        grossCents: win.gross_cents,
        discountsCents: win.discounts_cents,
        refundsCents: win.refunds_cents,
        priorNetCents: prior.net_cents,
        trendPct,
        ordersCount,
        cancelledCount: 0,
        aovCents,
        daily: dailyParsed.map((day) => ({
          date: day.metric_date,
          netCents: day.net_cents,
          orders: day.orders_count,
        })),
      },
      customers: {
        total: Number(customerTotals[0]?.total ?? "0"),
        newLastWindow: Number(newCustomers[0]?.total ?? "0"),
        vip: z.array(customerRow).parse(vipRows).map((row) => mapCustomer(row, now)),
        inactive: z.array(customerRow).parse(inactiveRows).map((row) => mapCustomer(row, now)),
        atRisk: z.array(customerRow).parse(atRiskRows).map((row) => mapCustomer(row, now)),
      },
      products: {
        trackedCount: stockParsed.length,
        topByRevenue: z.array(productSalesRow).parse(topRows).map((row) => ({
          id: row.id,
          title: row.title,
          priceCents: Math.round(row.price_cents),
          revenueCents: row.revenue_cents,
          units: row.units,
        })),
        lowStock,
        deadStock,
      },
      checkouts: {
        abandonedCount: checkouts.length,
        abandonedValueCents: checkouts.reduce((sum, checkout) => sum + checkout.totalCents, 0),
        abandoned: checkouts,
      },
      refunds: {
        count: Number(refundedOrders[0]?.total ?? "0"),
        cents: win.refunds_cents,
        ratePct: refundsRatePct,
      },
      inventory: {
        trackedVariants: inventorySummary.variants,
        outOfStock: inventorySummary.out_of_stock,
        lowStock: lowStock.length,
      },
      policy,
      learning: {
        generatedTotal: memory.generated_total,
        acceptedTotal: memory.accepted_total,
        rejectedTotal: memory.rejected_total,
        acceptanceRatePct:
          memory.accepted_total + memory.rejected_total > 0
            ? Math.round(
                (memory.accepted_total / (memory.accepted_total + memory.rejected_total)) * 100,
              )
            : null,
        attributedRevenueCents: memory.attributed_cents,
        attributedOrders: memory.attributed_orders,
      },
      computedAt: now.toISOString(),
    };
  });
}
