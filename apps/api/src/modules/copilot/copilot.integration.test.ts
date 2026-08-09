import { eq } from "@profit/db";
import {
  dailyMetrics,
  productMetrics,
  revenueMetrics,
  shopifyInventoryLevels,
  shopifyLocations,
  shopifyProducts,
  shopifyProductVariants,
  stores,
} from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestEnvironment,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../../test-support/harness";

/**
 * Copilot API (M8, ADR 32/35): deterministic answers over HTTP with RBAC,
 * validation and tenant pinning. The harness runs provider-null — the same
 * numbers the seeded aggregates imply, byte-for-byte.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";

function iso(daysBefore: number): string {
  return new Date(Date.now() - daysBefore * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-copilot", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "copilot-owner" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;

  // 30 days of revenue + one thin-cover product for the stockout intent.
  await env.db.insert(revenueMetrics).values(
    Array.from({ length: 30 }, (_, i) => ({
      storeId,
      metricDate: iso(30 - i),
      netSalesCents: 10_000,
      grossSalesCents: 12_000,
      discountsCents: 500,
      refundsCents: 0,
    })),
  );
  await env.db.insert(dailyMetrics).values(
    Array.from({ length: 30 }, (_, i) => ({
      storeId,
      metricDate: iso(30 - i),
      ordersCount: 4,
      cancelledOrders: 0,
      itemsSold: 8,
      newCustomers: 1,
      returningCustomers: 1,
      aovCents: 2_500,
    })),
  );
  const productRows = await env.db
    .insert(shopifyProducts)
    .values({ storeId, shopifyProductId: "cp-1", title: "Copper Kettle", status: "ACTIVE" })
    .returning();
  const locationRows = await env.db
    .insert(shopifyLocations)
    .values({ storeId, shopifyLocationId: "cp-loc", name: "Main" })
    .returning();
  await env.db.insert(shopifyProductVariants).values({
    storeId,
    productId: productRows[0]!.id,
    shopifyVariantId: "cp-v1",
    inventoryItemId: "cp-iem",
    sku: "CK-1",
  });
  await env.db.insert(shopifyInventoryLevels).values({
    storeId,
    inventoryItemId: "cp-iem",
    locationId: locationRows[0]!.id,
    available: 6,
  });
  await env.db.insert(productMetrics).values(
    Array.from({ length: 30 }, (_, i) => ({
      storeId,
      productId: productRows[0]!.id,
      metricDate: iso(30 - i),
      unitsSold: 2,
      revenueCents: 9_800,
    })),
  );
}, 120_000);

afterAll(async () => {
  await env.close();
});

describe("POST /api/v1/copilot/ask", () => {
  it("answers a stockout question from real evidence and persists the trail", async () => {
    const res = await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "What should I restock?" })
      .expect(201);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.intent).toBe("RESTOCK_WHAT");
    expect(data.modelEnhanced).toBe(false); // harness = provider-less deterministic path
    expect(data.answer).toContain("Copper Kettle");
    expect(data.answer).toContain("stockout.velocity.v1");
    expect(data.answer).toContain("confidence");
    expect(data.evidence.method).toBe("stockout.velocity.v1");

    const thread = await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "And how much revenue did we make?", conversationId: data.conversationId })
      .expect(201);
    expect(thread.body.data.conversationId).toBe(data.conversationId);
    expect(thread.body.data.intent).toBe("REVENUE_SUMMARY");
    expect(thread.body.data.answer).toContain("$3,000.00"); // 30 days × $100.00 net

    const list = await request(env.app)
      .get("/api/v1/copilot/conversations")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].title).toBe("What should I restock?");

    const detail = await request(env.app)
      .get(`/api/v1/copilot/conversations/${data.conversationId}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(detail.body.data.messages).toHaveLength(4);
    expect(detail.body.data.messages[0].role).toBe("MERCHANT");
    const assistant = detail.body.data.messages[1];
    expect(assistant.role).toBe("ASSISTANT");
    expect(assistant.intent).toBe("RESTOCK_WHAT");
    expect(assistant.payload.method).toBe("stockout.velocity.v1");
    expect(assistant.payload.matchedPattern).toBe("replenishment-need");
  });

  it("general questions get the capability card (honest, no invented numbers)", async () => {
    const res = await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "tell me a joke" })
      .expect(201);
    expect(res.body.data.intent).toBe("GENERAL_OTHER");
    expect(res.body.data.evidence.confidence).toBe(100);
  });

  it("rejects malformed payloads at the boundary", async () => {
    await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "x" })
      .expect(400);
    await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "valid length", smuggled: true })
      .expect(400);
    await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "follow up", conversationId: "not-a-uuid" })
      .expect(400);
  });

  it("foreign conversation ids answer 404, never a cross-tenant leak", async () => {
    await request(env.app)
      .get(`/api/v1/copilot/conversations/${crypto.randomUUID()}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(404);
    await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "follow up please", conversationId: crypto.randomUUID() })
      .expect(404);
  });

  it("requires authentication", async () => {
    await request(env.app).post("/api/v1/copilot/ask").send({ question: "hello there" }).expect(401);
  });

  it("RBAC: VIEWER cannot ask or read copilot threads", async () => {
    stubShopifyHttp({ accountOwner: false });
    const viewerSession = await signShopifySessionToken({ shopifyUserId: "copilot-viewer" });
    const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken: viewerSession }).expect(200);
    const viewerToken = login.body.data.accessToken as string;
    await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${viewerToken}`)
      .send({ question: "how are sales?" })
      .expect(403);
    await request(env.app)
      .get("/api/v1/copilot/conversations")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);
  });
});
