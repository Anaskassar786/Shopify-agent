import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "@profit/db";
import {
  customerMetrics,
  dailyMetrics,
  productMetrics,
  revenueMetrics,
  shopifyCustomers,
  shopifyInventoryLevels,
  shopifyLocations,
  shopifyMetafields,
  shopifyOrderLineItems,
  shopifyOrders,
  shopifyPriceRules,
  shopifyProducts,
  shopifyProductVariants,
  shopifyDiscountCodes,
  shopifyCollections,
  syncHistory,
  webhookLogs,
} from "@profit/db";
import { SyncModule, SyncStatus, WebhookStatus } from "@profit/types";
import {
  AnalyticsRefreshJob,
  ShopifyEnsureWebhooksJob,
  SyncModuleJob,
  SyncScheduledTickJob,
  SyncStoreFullJob,
  WebhookProcessJob,
} from "@profit/sync";
import {
  buildWorkerTestEnvironment,
  jsonResponse,
  WORKER_TEST_SHOP,
  type WorkerTestEnvironment,
} from "./test-support/harness";
import { upsertCustomers } from "@profit/sync";

/**
 * End-to-end worker suite. Real handlers → real in-process queue → real
 * Postgres. Fetch is the ONLY stub (the Shopify network boundary).
 */

let env: WorkerTestEnvironment;

beforeEach(async () => {
  env = await buildWorkerTestEnvironment();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.close();
});

// ── Shopify payload fixtures (REST serialization, exactly as Shopify sends) ──

function productPayload(id: number, title: string): Record<string, unknown> {
  return {
    id,
    title,
    handle: `p-${String(id)}`,
    status: "active",
    vendor: "Acme",
    product_type: "Shoes",
    tags: "featured, summer",
    body_html: "<b>desc</b>",
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-02T10:00:00Z",
    variants: [
      {
        id: id * 10 + 1,
        product_id: id,
        sku: `SKU-${String(id)}`,
        title: "Default",
        price: "49.99",
        compare_at_price: "59.99",
        inventory_item_id: id * 100 + 1,
        position: 1,
        created_at: "2026-07-01T10:00:00Z",
        updated_at: "2026-07-02T10:00:00Z",
      },
    ],
  };
}

function orderPayload(id: number, opts: {
  customerId?: number;
  processedAt: string;
  cancelledAt?: string | null;
  refunded?: boolean;
  subtotal?: string;
  products?: Array<{ productId: number; variantId: number; qty: number; price: string }>;
}): Record<string, unknown> {
  const lineItems = (opts.products ?? []).map((p, index) => ({
    id: id * 1000 + index + 1,
    product_id: p.productId,
    variant_id: p.variantId,
    sku: `SKU-${String(p.productId)}`,
    title: `Product ${String(p.productId)}`,
    quantity: p.qty,
    price: p.price,
    total_discount: "0.00",
  }));
  return {
    id,
    name: `#${String(id)}`,
    order_number: id,
    email: "buyer@example.com",
    financial_status: "paid",
    fulfillment_status: null,
    currency: "USD",
    subtotal_price: opts.subtotal ?? "100.00",
    total_discounts: "5.00",
    total_tax: "7.50",
    total_price: "110.00",
    total_shipping_price_set: { shop_money: { amount: "7.50" } },
    processed_at: opts.processedAt,
    cancelled_at: opts.cancelledAt ?? null,
    cancel_reason: opts.cancelledAt != null ? "customer" : null,
    test: false,
    tags: "",
    created_at: opts.processedAt,
    updated_at: opts.processedAt,
    ...(opts.customerId !== undefined ? { customer: { id: opts.customerId } } : {}),
    line_items: lineItems,
    refunds: opts.refunded === true
      ? [{
          id: id * 10 + 5,
          order_id: id,
          processed_at: opts.processedAt,
          transactions: [
            { id: id * 10 + 6, kind: "refund", status: "success", amount: "20.00", processed_at: opts.processedAt },
          ],
        }]
      : [],
  };
}

const DAY = "2026-08-01T12:00:00Z";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("full sync fan-out + module execution", () => {
  it("sync.store.full fans out per-module jobs that upsert products + variants with checkpoints", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/products.json")) {
        if (!url.includes("page_info")) {
          return jsonResponse({ products: [productPayload(501, "Runner"), productPayload(502, "Trail")] }, {
            headers: {
              link: `<https://${WORKER_TEST_SHOP}/admin/api/2025-10/products.json?limit=250&page_info=c2>; rel="next"`,
            },
          });
        }
        return jsonResponse({ products: [productPayload(503, "Hiker")] });
      }
      // Every other module drains an empty page.
      return jsonResponse({
        custom_collections: [], smart_collections: [], customers: [], orders: [],
        locations: [], inventory_levels: [], price_rules: [], metafields: [],
        data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    }));

    await env.deps.persistence.enqueuePersistent(
      env.queue,
      SyncStoreFullJob,
      { storeId: env.storeId, modules: [SyncModule.Products] },
      { jobId: "full-test-1" },
    );
    await env.settle();

    const products = await env.db.select().from(shopifyProducts);
    expect(products.map((p) => p.title).sort()).toEqual(["Hiker", "Runner", "Trail"]);
    const variants = await env.db.select().from(shopifyProductVariants);
    expect(variants).toHaveLength(3);
    expect(variants[0]?.price).toBe("49.99");
    expect(variants[0]?.inventoryItemId).not.toBeNull();

    const runs = await env.db
      .select()
      .from(syncHistory)
      .where(and(eq(syncHistory.storeId, env.storeId), eq(syncHistory.module, SyncModule.Products)));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe(SyncStatus.Completed);
    expect(runs[0]?.cursor).toBeNull();
    const stats = runs[0]?.stats as { processed: number; created: number; updated: number };
    expect(stats.created).toBe(6); // 3 products + 3 variants
    expect(stats.processed).toBe(6);

    // Pagination honored: second page went through page_info.
    expect(requestedUrls.filter((u) => u.includes("/products.json"))).toHaveLength(2);
    expect(requestedUrls[1]).toContain("page_info=c2");

    // Fan-in: orders module never ran, so no analytics job fired; but the
    // completed single-module group DID complete → analytics.refresh fired.
    const analyticsRuns = await env.db.select().from(dailyMetrics);
    expect(analyticsRuns).toHaveLength(0); // no orders yet
  });

  it("a crashed FULL run resumes from its stored page_info checkpoint", async () => {
    let phase: "fail" | "succeed" = "fail";
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/products.json")) {
        if (!url.includes("page_info")) {
          return jsonResponse({ products: [productPayload(601, "First")] }, {
            headers: { link: `<https://${WORKER_TEST_SHOP}/x?limit=250&page_info=resume_c2>; rel="next"` },
          });
        }
        if (phase === "fail") {
          return jsonResponse({ errors: "maintenance" }, { status: 500 });
        }
        return jsonResponse({ products: [productPayload(602, "Second")] });
      }
      return jsonResponse({ errors: "unstubbed" }, { status: 500 });
    }));

    // Run 1: dies on page 2 (fast transport + job backoff via harness env/def
    // — the retry MECHANISM is what this suite proves, not wall-clock time).
    await env.queue.enqueue(
      { ...SyncModuleJob, attempts: 1, backoffBaseMs: 5 },
      { storeId: env.storeId, module: SyncModule.Products, mode: "FULL" },
    );
    await env.settle();
    let runs = await env.db.select().from(syncHistory);
    expect(runs[0]?.status).toBe(SyncStatus.Failed);
    expect(runs[0]?.cursor).toBe("resume_c2");
    expect((await env.db.select().from(shopifyProducts)).map((p) => p.title)).toEqual(["First"]);

    // Run 2: resumes at the checkpoint — page 1 never refetched.
    phase = "succeed";
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push(String(input));
      return originalFetch(input as string, init);
    }));
    await env.queue.enqueue(SyncModuleJob, {
      storeId: env.storeId,
      module: SyncModule.Products,
      mode: "FULL",
    });
    await env.settle();
    runs = await env.db.select().from(syncHistory);
    expect(runs).toHaveLength(1); // same run row completed
    expect(runs[0]?.status).toBe(SyncStatus.Completed);
    expect(calls[0]).toContain("page_info=resume_c2");
    expect((await env.db.select().from(shopifyProducts)).map((p) => p.title).sort()).toEqual([
      "First",
      "Second",
    ]);
  });

  it("re-running a completed module updates in place (zero creates, exact updates)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/products.json")) {
        return jsonResponse({ products: [productPayload(701, "Same")] });
      }
      return jsonResponse({ errors: "unstubbed" }, { status: 500 });
    }));
    await env.queue.enqueue(SyncModuleJob, { storeId: env.storeId, module: SyncModule.Products, mode: "FULL" });
    await env.settle();
    await env.queue.enqueue(SyncModuleJob, { storeId: env.storeId, module: SyncModule.Products, mode: "FULL" });
    await env.settle();

    const products = await env.db.select().from(shopifyProducts);
    expect(products).toHaveLength(1);
    const runs = await env.db
      .select()
      .from(syncHistory)
      .where(eq(syncHistory.module, SyncModule.Products));
    expect(runs).toHaveLength(2);
    const stats2 = runs[1]?.stats as { created: number; updated: number };
    expect(stats2.created).toBe(0);
    expect(stats2.updated).toBe(2); // 1 product + 1 variant
  });
});

describe("orders → analytics pipeline", () => {
  async function seedCatalogAndOrders(): Promise<void> {
    await upsertCustomers(env.db, env.storeId, [
      {
        id: "9001", email: "new@example.com", first_name: "New", last_name: "Buyer",
        phone: null, state: "enabled", orders_count: 2, total_spent: "200.00",
        accepts_marketing: false, tags: [], created_at: null, updated_at: null,
      },
    ]);
    void 0;
  }

  it("computes exact cents math for daily/revenue/product/customer metrics", async () => {
    await seedCatalogAndOrders();
    // Two normal orders + one cancelled + one refunded, same UTC day.
    const orders = [
      orderPayload(8001, { customerId: 9001, processedAt: DAY, subtotal: "100.00", products: [{ productId: 501, variantId: 5011, qty: 2, price: "50.00" }] }),
      orderPayload(8002, { customerId: 9001, processedAt: DAY, subtotal: "200.00", refunded: true, products: [{ productId: 501, variantId: 5011, qty: 4, price: "50.00" }] }),
      orderPayload(8003, { processedAt: DAY, cancelledAt: "2026-08-01T13:00:00Z", subtotal: "999.00" }),
    ];
    // Ingest through the webhook pipeline for realism: orders/create ×3.
    for (const [index, payload] of orders.entries()) {
      const logId = await env.insertWebhookLog("orders/create", payload, `ord-${String(index)}`);
      await env.queue.enqueue(WebhookProcessJob, { storeId: env.storeId, webhookLogId: logId });
    }
    await env.settle();

    const daily = await env.db.select().from(dailyMetrics).where(eq(dailyMetrics.storeId, env.storeId));
    expect(daily).toHaveLength(1);
    const row = daily[0]!;
    // Metrics only aggregate when the analytics.refresh job ran — the webhook
    // pipeline enqueued it; settle() flushed the chain.
    expect(row.ordersCount).toBe(2);
    expect(row.cancelledOrders).toBe(1);
    expect(row.itemsSold).toBe(6);
    expect(row.newCustomers).toBe(2); // customer 9001's first & subsequent... computed per-customer first day
    expect(row.aovCents).toBe(15000); // avg(100, 200) = $150

    const revenue = await env.db.select().from(revenueMetrics).where(eq(revenueMetrics.storeId, env.storeId));
    expect(revenue).toHaveLength(1);
    const rev = revenue[0]!;
    // gross = sum(subtotal + discounts) = (100+5) + (200+5) = 310 → 31000
    expect(rev.grossSalesCents).toBe(31000);
    expect(rev.discountsCents).toBe(1000);
    expect(rev.refundsCents).toBe(2000);
    // net = sum(subtotal - refunded) = 100 + 180 = 280 → 28000
    expect(rev.netSalesCents).toBe(28000);
    expect(rev.taxesCents).toBe(1500);
    expect(rev.shippingCents).toBe(1500);

    // Product metrics need product FK resolution — products were never synced,
    // so line items carry product_id NULL and product_metrics stays empty.
    const pm = await env.db.select().from(productMetrics);
    expect(pm).toHaveLength(0);

    const cm = await env.db.select().from(customerMetrics).where(eq(customerMetrics.storeId, env.storeId));
    expect(cm).toHaveLength(1);
    expect(cm[0]?.ordersCount).toBe(2);
    expect(cm[0]?.totalSpentCents).toBe(30000);

    // Webhook logs all transitioned to PROCESSED.
    const logs = await env.db.select().from(webhookLogs);
    expect(logs.every((log) => log.status === WebhookStatus.Processed)).toBe(true);
  });

  it("webhook delivery replay is physically impossible (dedupe + status guard)", async () => {
    const payload = orderPayload(8101, { processedAt: DAY });
    const logId = await env.insertWebhookLog("orders/create", payload, "replay-key");
    await env.queue.enqueue(WebhookProcessJob, { storeId: env.storeId, webhookLogId: logId }, { jobId: "wh-replay" });
    await env.queue.enqueue(WebhookProcessJob, { storeId: env.storeId, webhookLogId: logId }, { jobId: "wh-replay" });
    await env.settle();
    const orders = await env.db.select().from(shopifyOrders);
    expect(orders).toHaveLength(1);

    // Direct replay against an already-processed row: no-op by the status guard.
    await env.queue.enqueue(WebhookProcessJob, { storeId: env.storeId, webhookLogId: logId }, { jobId: "wh-replay-2" });
    await env.settle();
    expect((await env.db.select().from(shopifyOrders)).length).toBe(1);
    const log = (await env.db.select().from(webhookLogs))[0]!;
    expect(log.status).toBe(WebhookStatus.Processed);
  });

  it("products/webhook appliers mutate the catalog + bump cache versions", async () => {
    const createId = await env.insertWebhookLog("products/create", productPayload(8801, "Hooky"), "p-create");
    await env.queue.enqueue(WebhookProcessJob, { storeId: env.storeId, webhookLogId: createId });
    await env.settle();
    expect((await env.db.select().from(shopifyProducts)).length).toBe(1);
    expect(await env.cacheVersion("catalog")).toBeGreaterThanOrEqual(1);

    const deleteId = await env.insertWebhookLog("products/delete", { id: 8801 }, "p-delete");
    await env.queue.enqueue(WebhookProcessJob, { storeId: env.storeId, webhookLogId: deleteId });
    await env.settle();
    expect((await env.db.select().from(shopifyProducts)).length).toBe(0);
  });

  it("failed appliers retry, then mark the webhook FAILED at the final attempt", async () => {
    // refunds/create with a forced 500 on the order refetch → applier throws.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: "down" }, { status: 500 })));
    const logId = await env.insertWebhookLog(
      "refunds/create",
      { id: 1, order_id: 9911, transactions: [] },
      "refund-fail",
    );
    // Same job contract, fast backoff for the suite — retries are the point,
    // not wall-clock time in the test.
    await env.queue.enqueue(
      { ...WebhookProcessJob, backoffBaseMs: 5 },
      { storeId: env.storeId, webhookLogId: logId },
      { jobId: "refund-job" },
    );
    await env.settle();
    const log = (await env.db.select().from(webhookLogs).where(eq(webhookLogs.id, logId)))[0]!;
    expect(log.status).toBe(WebhookStatus.Failed);
    expect(log.errorMessage).toBeTruthy();
  });
});

describe("scheduled maintenance", () => {
  it("sync.scheduled-tick fans out incremental runs for active stores only", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/products.json")) return jsonResponse({ products: [] });
      if (url.includes("/customers.json")) return jsonResponse({ customers: [] });
      if (url.includes("/orders.json")) return jsonResponse({ orders: [] });
      if (url.includes("/custom_collections.json")) return jsonResponse({ custom_collections: [] });
      if (url.includes("/smart_collections.json")) return jsonResponse({ smart_collections: [] });
      if (url.includes("/price_rules.json")) return jsonResponse({ price_rules: [] });
      return jsonResponse({ errors: "unstubbed " + url }, { status: 500 });
    }));
    await env.queue.enqueue(SyncScheduledTickJob, {});
    await env.settle();
    const runs = await env.db.select().from(syncHistory).where(eq(syncHistory.storeId, env.storeId));
    const modules = runs.map((run) => run.module).sort();
    expect(modules).toEqual(["COLLECTIONS", "CUSTOMERS", "DISCOUNTS", "ORDERS", "PRODUCTS"]);
    expect(runs.every((run) => run.status === SyncStatus.Completed)).toBe(true);
  });

  it("shopify.webhooks.ensure creates missing subscriptions and re-points drifted callbacks", async () => {
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("WebhookSubscriptions")) {
        return jsonResponse({
          data: {
            webhookSubscriptions: {
              nodes: [
                {
                  id: "gid://shopify/WebhookSubscription/1",
                  topic: "PRODUCTS_CREATE",
                  endpoint: { callbackUrl: "https://OLD.example.com/shopify/webhooks" },
                },
              ],
            },
          },
        });
      }
      if (body.query.includes("webhookSubscriptionUpdate")) {
        mutations.push(`update:${String((body.variables["webhookSubscription"] as { callbackUrl?: string }).callbackUrl)}`);
        return jsonResponse({
          data: { webhookSubscriptionUpdate: { webhookSubscription: { id: "gid://shopify/WebhookSubscription/1", topic: "PRODUCTS_CREATE" }, userErrors: [] } },
        });
      }
      if (body.query.includes("webhookSubscriptionCreate")) {
        mutations.push(`create:${String(body.variables["topic"])}`);
        return jsonResponse({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: "gid://shopify/WebhookSubscription/9", topic: body.variables["topic"] },
              userErrors: [],
            },
          },
        });
      }
      return jsonResponse({ errors: "unstubbed" }, { status: 500 });
    }));

    await env.queue.enqueue(ShopifyEnsureWebhooksJob, { storeId: env.storeId });
    await env.settle();

    // PRODUCTS_CREATE drifted → updated; the remaining registered topics created.
    expect(mutations.some((m) => m.startsWith("update:https://app.profit.test/shopify/webhooks"))).toBe(true);
    expect(mutations.filter((m) => m.startsWith("create:")).length).toBeGreaterThanOrEqual(10);
    expect(mutations).toContain("create:APP_UNINSTALLED");
  });

  it("inventory sync resolves locations before levels", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/locations.json")) {
        return jsonResponse({ locations: [{ id: 301, name: "Main", active: true }] });
      }
      if (url.includes("/inventory_levels.json")) {
        return jsonResponse({
          inventory_levels: [
            { inventory_item_id: 50101, location_id: 301, available: 17, updated_at: "2026-08-01T00:00:00Z" },
            { inventory_item_id: 99999, location_id: 404, available: 3, updated_at: null },
          ],
        });
      }
      return jsonResponse({ errors: "unstubbed" }, { status: 500 });
    }));
    await env.queue.enqueue(SyncModuleJob, { storeId: env.storeId, module: SyncModule.Inventory, mode: "FULL" });
    await env.settle();
    const locations = await env.db.select().from(shopifyLocations);
    expect(locations.map((l) => l.name)).toEqual(["Main"]);
    const levels = await env.db.select().from(shopifyInventoryLevels);
    expect(levels).toHaveLength(1);
    expect(levels[0]?.available).toBe(17);
    expect(levels[0]?.locationId).toBe(locations[0]!.id);
  });

  it("metafields sync covers shop scope (REST) and product scope (GraphQL)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/graphql.json")) {
        return jsonResponse({
          data: {
            products: {
              nodes: [{
                legacyResourceId: "501",
                metafields: {
                  nodes: [{ namespace: "seo", key: "score", type: "number_integer", value: "91", jsonValue: 91 }],
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (url.includes("/metafields.json")) {
        return jsonResponse({
          metafields: [{ id: 42, namespace: "brand", key: "story", type: "multi_line_text_field", value: "Hello", updated_at: null }],
        });
      }
      return jsonResponse({ errors: "unstubbed " + url }, { status: 500 });
    }));
    await env.queue.enqueue(SyncModuleJob, { storeId: env.storeId, module: SyncModule.Metafields, mode: "FULL" });
    await env.settle();
    const metafields = await env.db.select().from(shopifyMetafields);
    const owners = metafields.map((m) => m.ownerType).sort();
    expect(owners).toEqual(["PRODUCT", "SHOP"]);
    const productField = metafields.find((m) => m.ownerType === "PRODUCT");
    expect(productField?.value).toBe(91);
  });
});
