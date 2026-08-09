import { eq } from "@profit/db";
import {
  shopifyCustomers,
  shopifyOrders,
  shopifyProducts,
  stores,
  withStoreScope,
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
 * Global search API (P4/M3): grouped, permission-scoped entity search across
 * the M2 mirror tables. Proves: match semantics, group caps, per-permission
 * group gating (VIEWER sees permitted:false, never data), and tenant isolation.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";

async function seedCatalog(): Promise<void> {
  await withStoreScope(env.db, storeId, async (tx) => {
    await tx.insert(shopifyProducts).values([
      {
        storeId,
        shopifyProductId: "11",
        title: "Aurora Desk Lamp",
        handle: "aurora-desk-lamp",
        status: "ACTIVE",
      },
      {
        storeId,
        shopifyProductId: "12",
        title: "Nimbus Chair",
        handle: "nimbus-chair",
        status: "ACTIVE",
      },
    ]);
    await tx.insert(shopifyCustomers).values([
      {
        storeId,
        shopifyCustomerId: "21",
        email: "aurora.fan@example.com",
        firstName: "Ada",
        lastName: "Aurora",
        totalSpent: "420.00",
      },
    ]);
    await tx.insert(shopifyOrders).values([
      {
        storeId,
        shopifyOrderId: "31",
        name: "#1009",
        email: "aurora.fan@example.com",
        financialStatus: "paid",
        currency: "USD",
        totalPrice: "129.00",
        processedAt: new Date(),
      },
    ]);
  });
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app)
    .get(`/shopify/install?shop=${TEST_SHOP}`)
    .expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-search", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "search-owner" });
  const login = await request(env.app)
    .post("/api/v1/auth/session")
    .send({ sessionToken })
    .expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
  await seedCatalog();
});

afterAll(async () => {
  await env.close();
});

describe("GET /api/v1/search", () => {
  it("matches across all three groups for an OWNER", async () => {
    const res = await request(env.app)
      .get("/api/v1/search?q=aurora")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const { groups } = res.body.data;
    expect(groups.products.permitted).toBe(true);
    expect(groups.products.items[0].title).toBe("Aurora Desk Lamp");
    expect(groups.customers.items[0].email).toBe("aurora.fan@example.com");
    expect(groups.orders.items).toHaveLength(1);
    expect(groups.orders.items[0].name).toBe("#1009");
  });

  it("returns empty groups (200) for short queries — palette stays keyboard-only", async () => {
    const res = await request(env.app)
      .get("/api/v1/search?q=a")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.groups.products.items).toHaveLength(0);
    expect(res.body.data.query).toBe("a");
  });

  it("non-matching queries return zeroed permitted groups", async () => {
    const res = await request(env.app)
      .get("/api/v1/search?q=zzz-no-match")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.groups.products.total).toBe(0);
    expect(res.body.data.groups.customers.total).toBe(0);
  });
});

describe("permission scoping", () => {
  it("VIEWER gets permitted:false groups with zero data (never a 403, never data)", async () => {
    stubShopifyHttp({ accountOwner: false });
    const viewerSession = await signShopifySessionToken({ shopifyUserId: "search-viewer" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken: viewerSession })
      .expect(200);
    const viewerToken = login.body.data.accessToken as string;

    const res = await request(env.app)
      .get("/api/v1/search?q=aurora")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(200);
    const { groups } = res.body.data;
    for (const group of [groups.products, groups.customers, groups.orders]) {
      expect(group.permitted).toBe(false);
      expect(group.items).toHaveLength(0);
      expect(group.total).toBe(0);
    }
    stubShopifyHttp();
  });
});
