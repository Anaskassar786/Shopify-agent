import { describe, expect, it } from "vitest";
import { SyncModule } from "@profit/types";
import {
  pageParser,
  restCollectionSchema,
  restCustomerSchema,
  restDiscountCodeSchema,
  restInventoryLevelSchema,
  restLineItemSchema,
  restLocationSchema,
  restMetafieldSchema,
  restOrderSchema,
  restPriceRuleSchema,
  restProductSchema,
  restVariantSchema,
} from "./dto";
import {
  AnalyticsNightlyTickJob,
  AnalyticsRefreshJob,
  MaintenanceDailyTickJob,
  SCHEDULES,
  ShopifyEnsureWebhooksJob,
  SyncModuleJob,
  SyncScheduledTickJob,
  SyncStoreFullJob,
  WebhookProcessJob,
} from "./jobs";
import { FULL_SYNC_ORDER, SYNC_MODULES } from "./modules/index";
import { applierForTopic, REGISTERED_BUSINESS_TOPICS, WEBHOOK_APPLIERS } from "./webhook-appliers";
import { graphqlTopicName } from "./webhook-registrar";
import { windowForDates } from "./analytics";

/**
 * Pure contract tests for the data plane (P2): REST payload normalization,
 * job definitions, registry wiring and aggregation windowing. DB-coupled
 * modules (writers/runner/webhook handlers) are exercised by the worker and
 * API integration suites, which run the real PGlite migrations end-to-end.
 */

const VALID_UUID = "11111111-2222-4333-8444-555555555555";

describe("REST DTO normalization (shared by sync + webhooks)", () => {
  it("normalizes numeric Shopify ids to strings and timestamps to Dates", () => {
    const product = restProductSchema.parse({
      id: 8801234567890,
      title: "Aurora Hoodie",
      status: "active",
      created_at: "2026-07-01T10:00:00Z",
      unexpected_future_field: { keep: "me" },
    });
    expect(product.id).toBe("8801234567890");
    expect(product.created_at).toBeInstanceOf(Date);
    expect(product.created_at?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    // .passthrough(): forward compatibility with fields Shopify adds later.
    expect((product as Record<string, unknown>)["unexpected_future_field"]).toEqual({
      keep: "me",
    });
  });

  it("applies safe defaults when optional fields are absent", () => {
    const product = restProductSchema.parse({ id: "7" });
    expect(product.title).toBe("");
    expect(product.status).toBe("active");
    expect(product.tags).toEqual([]);
    expect(product.variants).toEqual([]);
    expect(product.vendor).toBeUndefined();
  });

  it("splits comma tags, drops empties, keeps arrays verbatim", () => {
    const fromString = restProductSchema.parse({ id: 1, tags: "sale,  summer , ," });
    expect(fromString.tags).toEqual(["sale", "summer"]);
    const fromArray = restProductSchema.parse({ id: 1, tags: ["sale", "vip"] });
    expect(fromArray.tags).toEqual(["sale", "vip"]);
  });

  it("variants default price to 0 and coerce money to string", () => {
    const variant = restVariantSchema.parse({ id: 11, product_id: 22, price: 19.99 });
    expect(variant.price).toBe("19.99");
    const bare = restVariantSchema.parse({ id: 11, product_id: 22 });
    expect(bare.price).toBe("0");
  });

  it("orders parse nested line items, refund transactions and shipping money", () => {
    const order = restOrderSchema.parse({
      id: 5001,
      name: "#1001",
      currency: "USD",
      total_price: "310.00",
      total_shipping_price_set: { shop_money: { amount: 10 } },
      customer: { id: 9001, email: "extra@example.com" },
      processed_at: "2026-08-01T12:00:00Z",
      line_items: [
        { id: 1, product_id: 100, variant_id: 200, quantity: 2, price: "150.00" },
      ],
      refunds: [
        {
          id: 8001,
          order_id: 5001,
          processed_at: "2026-08-02T09:30:00Z",
          transactions: [{ id: 8101, kind: "refund", status: "success", amount: "20.00" }],
        },
      ],
    });
    expect(order.id).toBe("5001");
    expect(order.currency).toBe("USD");
    expect(order.total_shipping_price_set?.shop_money.amount).toBe("10");
    expect(order.customer?.id).toBe("9001");
    expect(order.line_items[0]?.product_id).toBe("100");
    expect(order.line_items[0]?.quantity).toBe(2);
    expect(order.refunds[0]?.transactions[0]?.amount).toBe("20.00");
    expect(order.refunds[0]?.processed_at?.toISOString()).toBe("2026-08-02T09:30:00.000Z");
    expect(order.test).toBe(false);
  });

  it("line items tolerate null product/variant references", () => {
    const item = restLineItemSchema.parse({
      id: "5",
      product_id: null,
      variant_id: null,
      quantity: 3,
    });
    expect(item.product_id).toBeNull();
    expect(item.quantity).toBe(3);
    expect(item.total_discount).toBe("0");
  });

  it("customers coerce total_spent and default booleans", () => {
    const customer = restCustomerSchema.parse({
      id: 9001,
      email: "vip@example.com",
      total_spent: 1234.5,
      orders_count: 9,
    });
    expect(customer.total_spent).toBe("1234.5");
    expect(customer.accepts_marketing).toBe(false);
    expect(customer.tags).toEqual([]);
  });

  it("locations, inventory levels and collections normalize ids and defaults", () => {
    expect(restLocationSchema.parse({ id: 42 }).active).toBe(true);

    const level = restInventoryLevelSchema.parse({
      inventory_item_id: 777,
      location_id: "42",
      available: null,
    });
    expect(level.inventory_item_id).toBe("777");
    expect(level.location_id).toBe("42");
    // Explicit null is preserved (untracked items); absent falls back to 0.
    expect(level.available).toBeNull();
    const untracked = restInventoryLevelSchema.parse({ inventory_item_id: 1, location_id: 2 });
    expect(untracked.available).toBe(0);

    const collection = restCollectionSchema.parse({ id: 66, title: "Featured" });
    expect(collection.id).toBe("66");
  });

  it("price rules + discount codes + metafields keep unknown values intact", () => {
    const rule = restPriceRuleSchema.parse({ id: 12, value: "-10.00", value_type: "percentage" });
    expect(rule.value).toBe("-10.00");
    expect(rule.usage_count).toBe(0);

    const code = restDiscountCodeSchema.parse({ id: 13, price_rule_id: 12, code: "WELCOME10" });
    expect(code.price_rule_id).toBe("12");

    const metafield = restMetafieldSchema.parse({
      id: 14,
      namespace: "custom",
      key: "margin",
      value: { nested: [1, 2] },
    });
    expect(metafield.value).toEqual({ nested: [1, 2] });
  });

  it("rejects payloads without a Shopify id (refuse to write garbage)", () => {
    expect(() => restProductSchema.parse({ title: "no id" })).toThrow();
    expect(() => restOrderSchema.parse({ id: "" })).toThrow();
  });

  it("pageParser extracts the resource key and tolerates malformed bodies", () => {
    const parser = pageParser("products", restProductSchema);
    const parsed = parser.parse({ products: [{ id: 1 }, { id: 2 }], paging: {} });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toBe("1");

    expect(parser.parse({ other: [] })).toEqual([]);
    expect(parser.parse({ products: "not-an-array" })).toEqual([]);
    expect(() => parser.parse({ products: [{ no_id: true }] })).toThrow();
  });
});

describe("job contracts (producer/consumer drift = compile error)", () => {
  it("every job carries schema, attempts budget and timeout", () => {
    const jobs = [
      SyncStoreFullJob,
      SyncModuleJob,
      WebhookProcessJob,
      AnalyticsRefreshJob,
      ShopifyEnsureWebhooksJob,
      SyncScheduledTickJob,
      AnalyticsNightlyTickJob,
      MaintenanceDailyTickJob,
    ];
    for (const job of jobs) {
      expect(job.name.length).toBeGreaterThan(0);
      expect(job.queue.length).toBeGreaterThan(0);
      expect(job.timeoutMs).toBeGreaterThan(0);
      expect(() => job.schema.parse({ junk: true })).toThrow();
    }
  });

  it("validates payloads at the transport boundary", () => {
    expect(
      SyncStoreFullJob.schema.parse({
        storeId: VALID_UUID,
        modules: [SyncModule.Orders, SyncModule.Products],
        runGroupId: VALID_UUID,
      }).modules,
    ).toHaveLength(2);
    expect(() => SyncStoreFullJob.schema.parse({ storeId: "not-a-uuid" })).toThrow();
    expect(() =>
      SyncModuleJob.schema.parse({ storeId: VALID_UUID, module: "WARP_DRIVE", mode: "MANUAL" }),
    ).toThrow();
    expect(() =>
      SyncModuleJob.schema.parse({
        storeId: VALID_UUID,
        module: SyncModule.Orders,
        mode: "WHENEVER",
      }),
    ).toThrow();
    expect(
      WebhookProcessJob.schema.parse({ storeId: VALID_UUID, webhookLogId: VALID_UUID }).storeId,
    ).toBe(VALID_UUID);
    expect(
      AnalyticsRefreshJob.schema.parse({
        storeId: VALID_UUID,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-05",
      }).dateTo,
    ).toBe("2026-08-05");
    expect(() =>
      AnalyticsRefreshJob.schema.parse({ storeId: VALID_UUID, dateFrom: "08/01/2026" }),
    ).toThrow();
    expect(
      ShopifyEnsureWebhooksJob.schema.parse({ storeId: VALID_UUID }),
    ).toEqual({ storeId: VALID_UUID });
  });

  it("platform ticks are strict-empty payloads", () => {
    expect(SyncScheduledTickJob.schema.parse({})).toEqual({});
    expect(AnalyticsNightlyTickJob.schema.parse({})).toEqual({});
    expect(MaintenanceDailyTickJob.schema.parse({})).toEqual({});
  });

  it("schedule cadences are positive and ordered as designed", () => {
    expect(SCHEDULES.incrementalSyncEveryMs).toBe(60 * 60_000);
    expect(SCHEDULES.analyticsRefreshEveryMs).toBeGreaterThan(SCHEDULES.incrementalSyncEveryMs);
    expect(SCHEDULES.webhookEnsureEveryMs).toBeGreaterThan(SCHEDULES.analyticsRefreshEveryMs);
  });
});

describe("module registry", () => {
  it("exposes exactly the 8 sync modules with implementations", () => {
    expect(Object.keys(SYNC_MODULES).sort()).toEqual(
      [
        SyncModule.Checkouts, // M4: abandoned-checkout recovery feed
        SyncModule.Collections,
        SyncModule.Customers,
        SyncModule.Discounts,
        SyncModule.Inventory,
        SyncModule.Metafields,
        SyncModule.Orders,
        SyncModule.Products,
      ].sort(),
    );
    for (const impl of Object.values(SYNC_MODULES)) {
      expect(typeof impl.sync).toBe("function");
    }
  });

  it("FULL_SYNC_ORDER runs products before orders (FK resolution invariant)", () => {
    expect(FULL_SYNC_ORDER).toHaveLength(8);
    expect(FULL_SYNC_ORDER.indexOf(SyncModule.Products)).toBeLessThan(
      FULL_SYNC_ORDER.indexOf(SyncModule.Orders),
    );
    expect(FULL_SYNC_ORDER.indexOf(SyncModule.Customers)).toBeLessThan(
      FULL_SYNC_ORDER.indexOf(SyncModule.Orders),
    );
    expect(new Set(FULL_SYNC_ORDER).size).toBe(8);
  });
});

describe("webhook applier registry", () => {
  it("registers appliers for all 20 business topics", () => { // M4: +checkouts/create, +checkouts/update
    expect(REGISTERED_BUSINESS_TOPICS).toHaveLength(20);
    expect(REGISTERED_BUSINESS_TOPICS).toEqual(Object.keys(WEBHOOK_APPLIERS));
    expect(REGISTERED_BUSINESS_TOPICS).toContain("orders/create");
    expect(REGISTERED_BUSINESS_TOPICS).toContain("refunds/create");
    expect(REGISTERED_BUSINESS_TOPICS).toContain("inventory_levels/update");
    expect(REGISTERED_BUSINESS_TOPICS).toContain("discounts/delete");
    expect(REGISTERED_BUSINESS_TOPICS).toContain("checkouts/create");
    expect(REGISTERED_BUSINESS_TOPICS).toContain("checkouts/update");
  });

  it("applierForTopic resolves known topics and returns null for unknown", () => {
    expect(applierForTopic("products/update")).not.toBeNull();
    expect(applierForTopic("orders/create")).not.toBeNull();
    expect(applierForTopic("app/uninstalled")).toBeNull(); // inline handler, not data-plane
    expect(applierForTopic("shop/redact")).toBeNull(); // GDPR — mandatory channel
    expect(applierForTopic("made/up")).toBeNull();
  });
});

describe("aggregation windowing + topic mapping", () => {
  it("windowForDates folds webhook date lists into the smallest covering range", () => {
    expect(windowForDates([])).toEqual({ kind: "all" });
    expect(windowForDates(["2026-08-05"])).toEqual({
      kind: "range",
      dateFrom: "2026-08-05",
      dateTo: "2026-08-05",
    });
    expect(windowForDates(["2026-08-05", "2026-08-01", "2026-08-03"])).toEqual({
      kind: "range",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-05",
    });
  });

  it("graphqlTopicName maps REST topic names to GraphQL enum vocabulary", () => {
    expect(graphqlTopicName("products/create")).toBe("PRODUCTS_CREATE");
    expect(graphqlTopicName("inventory_levels/update")).toBe("INVENTORY_LEVELS_UPDATE");
    expect(graphqlTopicName("app/uninstalled")).toBe("APP_UNINSTALLED");
  });
});
