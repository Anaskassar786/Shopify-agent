import { eq } from "@profit/db";
import {
  currentScopedStoreId,
  stores,
  storeSettings,
  subscriptions,
  withStoreScope,
} from "@profit/db";
import { StoreStatus, UserRole } from "@profit/types";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtService } from "../auth/jwt.service";
import {
  ACCESS_SECRET,
  buildTestEnvironment,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  TEST_SUPPORT_EMAIL,
  type TestEnvironment,
} from "../../test-support/harness";

/**
 * Tenant isolation — the I2 invariant proven at every layer:
 *   1. withStoreScope pins app.store_id (asserted inside the transaction);
 *   2. Postgres RLS physically filters cross-tenant rows for the scoped role;
 *   3. cross-tenant WRITES violate the policy at the engine level;
 *   4. the HTTP stack returns each bearer exactly their own store through
 *      /api/v1/store, which reads exclusively through the scoped path.
 */

let env: TestEnvironment;

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
});

afterAll(async () => {
  await env.close();
});

async function install(shop: string, code: string): Promise<void> {
  const res = await request(env.app).get(`/shopify/install?shop=${shop}`).expect(302);
  const state = new URL(res.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code, shop, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
}

describe("PostgreSQL Row Level Security (P12 multi-tenant security)", () => {
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    await install(TEST_SHOP, "c-tenant-a");
    await install("second-store.myshopify.com", "c-tenant-b");
    const rows = await env.db.select().from(stores);
    storeAId = rows.find((r) => r.shopDomain === TEST_SHOP)!.id;
    storeBId = rows.find((r) => r.shopDomain === "second-store.myshopify.com")!.id;
  });

  it("pins the tenant inside the scoped transaction", async () => {
    const pinned = await withStoreScope(env.db, storeAId, async (tx) => {
      return currentScopedStoreId(tx);
    });
    expect(pinned).toBe(storeAId);
  });

  it("a scoped connection physically cannot SELECT another tenant's rows", async () => {
    const visible = await withStoreScope(env.db, storeAId, async (tx) => {
      return tx.select().from(stores);
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(storeAId);

    const visibleSettings = await withStoreScope(env.db, storeAId, async (tx) => {
      return tx.select().from(storeSettings);
    });
    expect(visibleSettings.every((row) => row.storeId === storeAId)).toBe(true);
  });

  it("cross-tenant INSERT violates the policy at the engine level", async () => {
    await expect(
      withStoreScope(env.db, storeAId, async (tx) => {
        await tx.insert(storeSettings).values({ storeId: storeBId });
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cross-tenant UPDATE is a no-op, not a leak", async () => {
    const affected = await withStoreScope(env.db, storeAId, async (tx) => {
      return tx
        .update(storeSettings)
        .set({ branding: { hijack: true } })
        .where(eq(storeSettings.storeId, storeBId))
        .returning({ storeId: storeSettings.storeId });
    });
    expect(affected).toHaveLength(0);
  });

  it("owner-path platform queries still work (install/migrations path)", async () => {
    const all = await env.db.select().from(stores);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe("HTTP tenant boundary: /api/v1/store", () => {
  let storeAId: string;
  let storeBId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    const rows = await env.db.select().from(stores);
    storeAId = rows.find((r) => r.shopDomain === TEST_SHOP)!.id;
    storeBId = rows.find((r) => r.shopDomain === "second-store.myshopify.com")!.id;

    stubShopifyHttp({ accountOwner: true });
    const sessionToken = await signShopifySessionToken({ shopifyUserId: "tenant-owner" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken })
      .expect(200);
    ownerUserId = login.body.data.user.id as string;
  });

  it("returns the caller's own store, settings and subscription", async () => {
    const sessionToken = await signShopifySessionToken({ shopifyUserId: "tenant-owner" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken })
      .expect(200);

    const res = await request(env.app)
      .get("/api/v1/store")
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .expect(200);

    expect(res.body.data.store.id).toBe(storeAId);
    expect(res.body.data.store.shopDomain).toBe(TEST_SHOP);
    expect(res.body.data.subscription.status).toBe("TRIALING");
    expect(res.body.data.settings).not.toBeNull();
    // M7: the platform support mailbox travels alongside the store payload so
    // the Support surface and legal pages share one configured source.
    expect(res.body.data.supportEmail).toBe(TEST_SUPPORT_EMAIL);
  });

  it("a token minted for store B can never read store A through the API", async () => {
    // Mint a syntactically valid app JWT whose claims sit in store B
    // (as would happen if the same human belonged to both stores).
    const jwt = new JwtService({ accessSecret: ACCESS_SECRET, accessTtlSeconds: 900 });
    const forged = await jwt.signAccessToken({
      userId: ownerUserId,
      sessionId: "66666666-7777-4888-8999-000000000000",
      storeId: storeBId,
      role: UserRole.Owner,
      permissions: ["store:read"],
    });
    const res = await request(env.app)
      .get("/api/v1/store")
      .set("Authorization", `Bearer ${forged}`)
      .expect(200);
    // The identity only ever sees ITS claim-scoped tenant — never store A.
    expect(res.body.data.store.id).toBe(storeBId);
    expect(res.body.data.store.shopDomain).toBe("second-store.myshopify.com");
  });

  it("suspended stores are refused at the tenant gate (403)", async () => {
    await env.db
      .update(stores)
      .set({ status: StoreStatus.Suspended })
      .where(eq(stores.id, storeBId));
    const jwt = new JwtService({ accessSecret: ACCESS_SECRET, accessTtlSeconds: 900 });
    const forged = await jwt.signAccessToken({
      userId: ownerUserId,
      sessionId: "66666666-7777-4888-8999-000000000000",
      storeId: storeBId,
      role: UserRole.Owner,
      permissions: ["store:read"],
    });
    await request(env.app)
      .get("/api/v1/store")
      .set("Authorization", `Bearer ${forged}`)
      .expect(403);
    await env.db
      .update(stores)
      .set({ status: StoreStatus.Active })
      .where(eq(stores.id, storeBId));
  });

  it("stores without settings/subscription rows return nulls (provisioning edge)", async () => {
    // Can only occur between store insert and settings/subscription
    // provisioning (or after a failed rollout) — the API must still answer.
    const settingsRow = await env.db
      .select()
      .from(storeSettings)
      .where(eq(storeSettings.storeId, storeBId));
    const subRow = await env.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.storeId, storeBId));
    expect(settingsRow).toHaveLength(1);
    expect(subRow).toHaveLength(1);

    await env.db.delete(subscriptions).where(eq(subscriptions.storeId, storeBId));
    await env.db.delete(storeSettings).where(eq(storeSettings.storeId, storeBId));
    try {
      const jwt = new JwtService({ accessSecret: ACCESS_SECRET, accessTtlSeconds: 900 });
      const token = await jwt.signAccessToken({
        userId: ownerUserId,
        sessionId: "66666666-7777-4888-8999-000000000000",
        storeId: storeBId,
        role: UserRole.Owner,
        permissions: ["store:read"],
      });
      const res = await request(env.app)
        .get("/api/v1/store")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.store.id).toBe(storeBId);
      expect(res.body.data.settings).toBeNull();
      expect(res.body.data.subscription).toBeNull();
    } finally {
      await env.db.insert(storeSettings).values(settingsRow);
      await env.db.insert(subscriptions).values(subRow);
    }
  });
});
