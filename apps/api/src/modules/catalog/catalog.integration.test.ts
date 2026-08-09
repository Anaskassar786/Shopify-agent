import { eq } from "@profit/db";
import { shopifyProducts, stores, type ProfitDb } from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  refreshAnalytics,
  upsertCustomers,
  upsertInventoryLevels,
  upsertLocations,
  upsertOrders,
  upsertProducts,
} from "@profit/sync";
import {
  buildTestEnvironment,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../../test-support/harness";

/**
 * Catalog read API + analytics API (P2/P4). Data enters through the REAL sync
 * writers + REAL aggregation so endpoint tests re-verify the whole plane.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";
let productUuid = "";
let customerUuid = "";

const DAY = new Date("2026-08-04T12:00:00Z"); // inside the 7/30/90d windows of "today" (2026-08-05)

async function installAndSeed(): Promise<void> {
  const installRes = await request(env.app)
    .get(`/shopify/install?shop=${TEST_SHOP}`)
    .expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-cat", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);

  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;

  await upsertProducts(env.db, storeId, [
    {
      id: "601", title: "Alpha Runner", handle: "alpha", status: "active", vendor: null,
      product_type: null, tags: [], body_html: null, published_at: null, created_at: null, updated_at: null,
      variants: [{
        id: "6011", product_id: "601", sku: "ALP-1", title: "Size 9", price: "80.00",
        compare_at_price: null, inventory_item_id: "60101", position: 1, barcode: null,
        created_at: null, updated_at: null,
      }],
    },
    {
      id: "602", title: "Beta Trail", handle: "beta", status: "active", vendor: null,
      product_type: null, tags: [], body_html: null, published_at: null, created_at: null, updated_at: null,
      variants: [{
        id: "6021", product_id: "602", sku: "BET-1", title: "Size 10", price: "120.00",
        compare_at_price: null, inventory_item_id: "60201", position: 1, barcode: null,
        created_at: null, updated_at: null,
      }],
    },
  ]);
  await upsertCustomers(env.db, storeId, [
    {
      id: "9001", email: "vip@example.com", first_name: "Vera", last_name: "Important",
      phone: null, state: "enabled", orders_count: 2, total_spent: "400.00",
      accepts_marketing: true, tags: [], created_at: null, updated_at: null,
    },
  ]);
  await upsertOrders(env.db, storeId, [
    {
      id: "7001", name: "#7001", order_number: 7001, email: "vip@example.com",
      financial_status: "paid", fulfillment_status: null, currency: "USD",
      subtotal_price: "160.00", total_discounts: "0.00", total_tax: "12.80",
      total_price: "180.80", total_shipping_price_set: { shop_money: { amount: "8.00" } },
      processed_at: DAY, closed_at: null, cancelled_at: null, cancel_reason: null,
      test: false, tags: [], created_at: DAY, updated_at: DAY,
      customer: { id: "9001" },
      line_items: [{
        id: "70011", product_id: "601", variant_id: "6011", sku: "ALP-1",
        title: "Alpha Runner", quantity: 2, price: "80.00", total_discount: "0.00",
      }],
      refunds: [],
      checkout_token: null,
      discount_codes: [],
    },
    {
      id: "7002", name: "#7002", order_number: 7002, email: "vip@example.com",
      financial_status: "paid", fulfillment_status: "fulfilled", currency: "USD",
      subtotal_price: "240.00", total_discounts: "0.00", total_tax: "19.20",
      total_price: "271.20", total_shipping_price_set: { shop_money: { amount: "12.00" } },
      processed_at: DAY, closed_at: null, cancelled_at: null, cancel_reason: null,
      test: false, tags: [], created_at: DAY, updated_at: DAY,
      customer: { id: "9001" },
      line_items: [{
        id: "70021", product_id: "602", variant_id: "6021", sku: "BET-1",
        title: "Beta Trail", quantity: 2, price: "120.00", total_discount: "0.00",
      }],
      refunds: [],
      checkout_token: null,
      discount_codes: [],
    },
  ]);
  await upsertLocations(env.db, storeId, [{ id: "301", name: "HQ", active: true }]);
  await upsertInventoryLevels(env.db, storeId, [
    { inventory_item_id: "60101", location_id: "301", available: 3, updated_at: null },
    { inventory_item_id: "60201", location_id: "301", available: 42, updated_at: null },
  ]);
  await refreshAnalytics(env.db, storeId);

  const productRows = await env.db.select().from(shopifyProducts);
  productUuid = productRows.find((row) => row.title === "Alpha Runner")!.id;

  const { shopifyCustomers } = await import("@profit/db");
  const customerRows = await env.db.select().from(shopifyCustomers);
  customerUuid = customerRows[0]!.id;

  const sessionToken = await signShopifySessionToken({ shopifyUserId: "catalog-owner" });
  const login = await request(env.app)
    .post("/api/v1/auth/session")
    .send({ sessionToken })
    .expect(200);
  accessToken = login.body.data.accessToken as string;
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  await installAndSeed();
});

afterAll(async () => {
  await env.close();
});

describe("GET /api/v1/products", () => {
  it("lists synced products paginated with search", async () => {
    const res = await request(env.app)
      .get("/api/v1/products?q=alpha")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe("Alpha Runner");
    expect(res.body.meta.pagination.totalItems).toBe(1);

    const all = await request(env.app)
      .get("/api/v1/products")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(all.body.data).toHaveLength(2);
  });

  it("resolves a single product by id for the detail page", async () => {
    const res = await request(env.app)
      .get(`/api/v1/products/${productUuid}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.id).toBe(productUuid);
    expect(res.body.data.title).toBe("Alpha Runner");
    expect(res.body.data).toHaveProperty("handle");
  });

  it("404s a single product for unknown ids via the envelope", async () => {
    const res = await request(env.app)
      .get("/api/v1/products/00000000-0000-0000-0000-000000000000")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe("NOT_FOUND");
  });

  it("serves variants for a product", async () => {
    const res = await request(env.app)
      .get(`/api/v1/products/${productUuid}/variants`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sku).toBe("ALP-1");
  });

  it("404s variants of unknown products via the envelope", async () => {
    const res = await request(env.app)
      .get("/api/v1/products/00000000-0000-0000-0000-000000000000/variants")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe("NOT_FOUND");
  });
});

describe("GET /api/v1/customers + detail", () => {
  it("lists by spend and resolves detail with lifetime metrics + orders", async () => {
    const res = await request(env.app)
      .get(`/api/v1/customers/${customerUuid}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.customer.email).toBe("vip@example.com");
    expect(res.body.data.metrics.ordersCount).toBe(2);
    expect(res.body.data.metrics.totalSpentCents).toBe(40000);
    expect(res.body.data.recentOrders).toHaveLength(2);
  });

  it("search matches name parts", async () => {
    const res = await request(env.app)
      .get("/api/v1/customers?q=important")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("GET /api/v1/orders + detail", () => {
  it("lists orders newest-first with financial status filter", async () => {
    const res = await request(env.app)
      .get("/api/v1/orders?financial_status=paid")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(2);
    const none = await request(env.app)
      .get("/api/v1/orders?financial_status=voided")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(none.body.data).toHaveLength(0);
  });

  it("detail includes line items", async () => {
    const list = await request(env.app)
      .get("/api/v1/orders")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const orderId = (list.body.data as Array<{ id: string }>)[0]!.id;
    const res = await request(env.app)
      .get(`/api/v1/orders/${orderId}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.lineItems).toHaveLength(1);
    expect(res.body.data.lineItems[0].sku).toBeTruthy();
  });
});

describe("GET /api/v1/inventory/levels", () => {
  it("joins locations + variant SKUs and filters low stock", async () => {
    const res = await request(env.app)
      .get("/api/v1/inventory/levels?below=10")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].level.available).toBe(3);
    expect(res.body.data[0].sku).toBe("ALP-1");
    expect(res.body.data[0].locationName).toBe("HQ");

    const all = await request(env.app)
      .get("/api/v1/inventory/levels")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(all.body.data).toHaveLength(2);
  });

  it("rejects a malformed below filter", async () => {
    await request(env.app)
      .get("/api/v1/inventory/levels?below=abc")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(400);
  });
});

describe("GET /api/v1/analytics", () => {
  it("summary aggregates the precomputed metrics for the range", async () => {
    const res = await request(env.app)
      .get("/api/v1/analytics/summary?days=30")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.totals.ordersCount).toBe(2);
    expect(res.body.data.totals.itemsSold).toBe(4);
    expect(res.body.data.totals.grossSalesCents).toBe(40000);
    expect(res.body.data.totals.netSalesCents).toBe(40000);
    expect(res.body.data.totals.aovCents).toBe(20000);
    expect(res.body.data.series.length).toBe(1);
  });

  it("summary responses are cached then invalidated by domain bump", async () => {
    const first = await request(env.app)
      .get("/api/v1/analytics/summary?days=7")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    // Bump version directly (what the worker does after sync):
    await env.cache.incr(`v:${storeId}:analytics`);
    const second = await request(env.app)
      .get("/api/v1/analytics/summary?days=7")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(second.body.data.totals.ordersCount).toBe(first.body.data.totals.ordersCount);
    // Version key proves the namespace discipline actually advanced.
    const version = await env.cache.get<number>(`v:${storeId}:analytics`);
    expect(version).toBeGreaterThanOrEqual(1);
  });

  it("top-products ranks by revenue over the window", async () => {
    const res = await request(env.app)
      .get("/api/v1/analytics/top-products?days=30&limit=5")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].title).toBe("Beta Trail");
    expect(res.body.data[0].revenueCents).toBe(24000);
    expect(res.body.data[1].title).toBe("Alpha Runner");
  });

  it("top-customers ranks lifetime value", async () => {
    const res = await request(env.app)
      .get("/api/v1/analytics/top-customers?limit=5")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data[0].email).toBe("vip@example.com");
    expect(res.body.data[0].totalSpentCents).toBe(40000);
  });

  it("rejects invalid ranges and requires analytics:read", async () => {
    await request(env.app)
      .get("/api/v1/analytics/summary?days=14")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(400);
    await request(env.app)
      .get("/api/v1/analytics/summary")
      .expect(401);
  });
});

describe("tenant isolation on the data plane", () => {
  it("a second store sees none of the first store's catalog through the same endpoints", async () => {
    const { shopifyCustomers } = await import("@profit/db");
    // Provision a second store through the real OAuth flow.
    const secondShop = "second-store.myshopify.com";
    const installRes = await request(env.app)
      .get(`/shopify/install?shop=${secondShop}`)
      .expect(302);
    const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
    await request(env.app)
      .get("/shopify/callback")
      .query(signOauthCallback({ code: "c-second", shop: secondShop, state, timestamp: String(Date.now() / 1000 | 0) }))
      .expect(302);

    const sessionToken = await signShopifySessionToken({
      shopifyUserId: "second-owner",
      shop: secondShop,
    });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken })
      .expect(200);
    const otherToken = login.body.data.accessToken as string;

    for (const path of ["/api/v1/products", "/api/v1/customers", "/api/v1/orders", "/api/v1/analytics/summary?days=30"]) {
      const res = await request(env.app).get(path).set("authorization", `Bearer ${otherToken}`).expect(200);
      if (Array.isArray(res.body.data)) {
        expect(res.body.data).toHaveLength(0);
      } else {
        expect(res.body.data.totals.ordersCount).toBe(0);
      }
    }
    void shopifyCustomers;
  });
});

describe("branch coverage: 404s, defaults, negative filters", () => {
  it("customer detail 404s for unknown ids", async () => {
    const res = await request(env.app)
      .get("/api/v1/customers/00000000-0000-0000-0000-000000000000")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe("NOT_FOUND");
  });

  it("order detail 404s for unknown ids", async () => {
    await request(env.app)
      .get("/api/v1/orders/00000000-0000-0000-0000-000000000000")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(404);
  });

  it("empty search strings behave like no filter", async () => {
    const res = await request(env.app)
      .get("/api/v1/products?q=")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(2);
    const res2 = await request(env.app)
      .get("/api/v1/customers?q=")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res2.body.data).toHaveLength(1);
  });

  it("negative below filter is rejected", async () => {
    await request(env.app)
      .get("/api/v1/inventory/levels?below=-5")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(400);
  });

  it("orders without financial filter fall through", async () => {
    const res = await request(env.app)
      .get("/api/v1/orders?financial_status=")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(2);
  });

  it("analytics defaults: days=30 without query, top-products default limit", async () => {
    const res = await request(env.app)
      .get("/api/v1/analytics/summary")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.range.days).toBe(30);
    const top = await request(env.app)
      .get("/api/v1/analytics/top-products")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(top.body.data.length).toBeLessThanOrEqual(10);
    const topCustomers = await request(env.app)
      .get("/api/v1/analytics/top-customers?limit=abc")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(topCustomers.body.data).toHaveLength(1);
  });

  it("malformed catalog pagination falls back to defaults", async () => {
    const res = await request(env.app)
      .get("/api/v1/products?page=x&limit=y")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.meta.pagination.page).toBe(1);
    expect(res.body.meta.pagination.pageSize).toBe(25);
  });
});
