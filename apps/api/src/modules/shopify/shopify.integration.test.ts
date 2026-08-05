import { eq } from "@profit/db";
import {
  auditLogs,
  shopifyOauthStates,
  shopifySessions,
  stores,
  subscriptions,
  webhookLogs,
} from "@profit/db";
import { StoreStatus, SubscriptionStatus, WebhookStatus } from "@profit/types";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestEnvironment,
  shopifyWebhookHeaders,
  signOauthCallback,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../../test-support/harness";

/**
 * OAuth install + webhook pipeline against the REAL app, REAL Postgres (PGlite),
 * REAL migrations. Only outbound calls to Shopify's servers are stubbed (the
 * network boundary). Covers P2: OAuth, HMAC, webhooks; P5: replay/state
 * validation, uninstall cleanup; P12: webhook dedupe.
 */

let env: TestEnvironment;

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
});

afterAll(async () => {
  await env.close();
});

describe("GET /shopify/install", () => {
  it("rejects an invalid shop domain with a structured 400", async () => {
    const res = await request(env.app).get("/shopify/install?shop=not a domain").expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].code).toBe("VALIDATION_FAILED");
  });

  it("redirects to Shopify authorize with a persisted, single-use state", async () => {
    const res = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
    const location = new URL(res.headers["location"] as string);
    expect(location.hostname).toBe(TEST_SHOP);
    expect(location.pathname).toBe("/admin/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBeTruthy();

    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    const rows = await env.db
      .select()
      .from(shopifyOauthStates)
      .where(eq(shopifyOauthStates.state, state as string));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usedAt).toBeNull();
    expect(rows[0]?.shopDomain).toBe(TEST_SHOP);
  });
});

describe("GET /shopify/callback", () => {
  async function installUrlState(): Promise<string> {
    const res = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
    return new URL(res.headers["location"] as string).searchParams.get("state") as string;
  }

  function callbackQuery(state: string): Record<string, string> {
    return signOauthCallback({
      code: "oauth_code_abc",
      shop: TEST_SHOP,
      state,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
  }

  it("rejects a tampered HMAC before touching state", async () => {
    const state = await installUrlState();
    const params = {
      code: "oauth_code_abc",
      shop: TEST_SHOP,
      state,
      timestamp: String(Math.floor(Date.now() / 1000)),
      hmac: "deadbeef".repeat(8),
    };
    await request(env.app).get("/shopify/callback").query(params).expect(401);
    // State must remain usable (rejection happened before burn).
    const rows = await env.db
      .select()
      .from(shopifyOauthStates)
      .where(eq(shopifyOauthStates.state, state));
    expect(rows[0]?.usedAt).toBeNull();
  });

  it("provisions the store end-to-end on a valid callback", async () => {
    const state = await installUrlState();
    const res = await request(env.app)
      .get("/shopify/callback")
      .query(callbackQuery(state))
      .expect(302);
    expect(res.headers["location"]).toContain("admin.shopify.com");

    const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
    expect(storeRows).toHaveLength(1);
    const store = storeRows[0]!;
    expect(store.status).toBe(StoreStatus.Active);
    expect(store.name).toBe("Demo Store");
    expect(store.currency).toBe("USD");
    expect(store.timezone).toBe("America/New_York");

    const tokenRows = await env.db
      .select()
      .from(shopifySessions)
      .where(eq(shopifySessions.storeId, store.id));
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]?.sessionType).toBe("OFFLINE");
    // Stored encrypted at rest — never the raw token, decryptable with our key.
    expect(tokenRows[0]?.accessTokenEncrypted).not.toContain("fixture_offline_access_token_value");
    expect(env.encryption.decrypt(tokenRows[0]!.accessTokenEncrypted)).toBe("fixture_offline_access_token_value");

    const subs = await env.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.storeId, store.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe(SubscriptionStatus.Trialing);
    expect(subs[0]?.trialEndsAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("burns state on first use — replaying the callback fails (P5 replay prevention)", async () => {
    const state = await installUrlState();
    const query = callbackQuery(state);
    await request(env.app).get("/shopify/callback").query(query).expect(302);
    await request(env.app).get("/shopify/callback").query(query).expect(401);
  });
});

describe("POST /shopify/webhooks", () => {
  function webhookDelivery(
    topic: string,
    deliveryId: string,
    payload: unknown,
    shop: string = TEST_SHOP,
  ) {
    const raw = Buffer.from(JSON.stringify(payload), "utf8");
    return { raw, headers: shopifyWebhookHeaders(shop, topic, deliveryId, raw) };
  }

  it("rejects an invalid signature with 401 and stores NOTHING", async () => {
    const { raw, headers } = webhookDelivery("app/uninstalled", "del-badhmac", { id: 1 });
    const before = await env.db.select().from(webhookLogs);
    await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...headers, "x-shopify-hmac-sha256": "invalid", "content-type": "application/json" })
      .send(raw.toString("utf8"))
      .expect(401);
    const after = await env.db.select().from(webhookLogs);
    expect(after).toHaveLength(before.length);
  });

  it("processes app/uninstalled: cleanup + ack (P5 uninstall cleanup)", async () => {
    const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
    expect(storeRows[0]?.status).toBe(StoreStatus.Active);

    const { raw, headers } = webhookDelivery("app/uninstalled", "del-uninstall-1", { id: 777001 });
    await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...headers, "content-type": "application/json" })
      .send(raw.toString("utf8"))
      .expect(200);

    const after = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
    expect(after[0]?.status).toBe(StoreStatus.Uninstalled);
    expect(after[0]?.uninstalledAt).not.toBeNull();

    const tokens = await env.db
      .select()
      .from(shopifySessions)
      .where(eq(shopifySessions.storeId, after[0]!.id));
    expect(tokens).toHaveLength(0);

    const logs = await env.db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.storeId, after[0]!.id));
    expect(logs.map((l) => l.topic)).toContain("app/uninstalled");
    expect(logs.find((l) => l.topic === "app/uninstalled")?.status).toBe(WebhookStatus.Processed);
  });

  it("dedupes repeat deliveries — single stored row, ack both times (P12)", async () => {
    // Reinstall first so the store is active again for subsequent suites.
    const res = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
    const state = new URL(res.headers["location"] as string).searchParams.get("state") as string;
    await request(env.app)
      .get("/shopify/callback")
      .query(signOauthCallback({ code: "c2", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
      .expect(302);

    const { raw, headers } = webhookDelivery("customers/create", "del-customer-dup", {
      id: 555001,
      email: "customer@example.com",
      first_name: "Jane",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res2 = await request(env.app)
        .post("/shopify/webhooks")
        .set({ ...headers, "content-type": "application/json" })
        .send(raw.toString("utf8"))
        .expect(200);
      expect(res2.body.data.outcome).toBe(attempt === 0 ? "processed" : "duplicate");
    }

    const rows = await env.db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.shopifyWebhookId, "del-customer-dup"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(WebhookStatus.Processed);
  });

  it("acknowledges webhooks for unknown stores without retry-baiting (200, logged)", async () => {
    const { raw, headers } = webhookDelivery(
      "app/uninstalled",
      "del-unknown-store",
      { id: 1 },
      "ghost-store.myshopify.com",
    );
    const res = await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...headers, "content-type": "application/json" })
      .send(raw.toString("utf8"))
      .expect(200);
    expect(res.body.data.outcome).toBe("ignored-unknown-store");
  });

  it("customers/data_request is acknowledged and audit-logged for the export workflow (GDPR)", async () => {
    const { raw, headers } = webhookDelivery("customers/data_request", "del-datareq-1", {
      shop_id: 777001,
      shop_domain: TEST_SHOP,
      customer: { id: 555999, email: "export-me@example.com" },
      orders_requested: [10, 11],
    });
    const res = await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...headers, "content-type": "application/json" })
      .send(raw.toString("utf8"))
      .expect(200);
    expect(res.body.data.outcome).toBe("processed");

    const audit = await env.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "gdpr.customers.data_request"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.metadata).toMatchObject({ customerCount: 1, ordersRequested: 2 });
  });

  it("shop/redact purges ALL retained payloads and store contact PII for the shop (GDPR)", async () => {
    // Plant a residual payload to be purged.
    const plant = webhookDelivery("products/create", "del-preredact-target", { id: 1, title: "x" });
    await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...plant.headers, "content-type": "application/json" })
      .send(plant.raw.toString("utf8"))
      .expect(200);

    const { raw, headers } = webhookDelivery("shop/redact", "del-shopredact-1", {
      shop_id: 777001,
      shop_domain: TEST_SHOP,
    });
    await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...headers, "content-type": "application/json" })
      .send(raw.toString("utf8"))
      .expect(200);

    const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
    expect(storeRows[0]?.email).toBeNull();

    const planted = await env.db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.shopifyWebhookId, "del-preredact-target"));
    expect(planted[0]?.payload).toEqual({ redacted: true });
  });

  it("webhook registration failure does not fail install — it is audited as FAILURE (P5 monitoring)", async () => {
    const failShop = "regfail-store.myshopify.com";
    stubShopifyHttp({ failWebhookRegistration: true });
    const res = await request(env.app).get(`/shopify/install?shop=${failShop}`).expect(302);
    const state = new URL(res.headers["location"] as string).searchParams.get("state") as string;
    await request(env.app)
      .get("/shopify/callback")
      .query(signOauthCallback({ code: "c-regfail", shop: failShop, state, timestamp: String(Date.now() / 1000 | 0) }))
      .expect(302);

    const audit = await env.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "shopify.webhook.registration_failed"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.result).toBe("FAILURE");
    stubShopifyHttp();
  });

  it("customers/redact physically scrubs stored customer payloads (GDPR)", async () => {
    const create = webhookDelivery("customers/create", "del-customer-redact-target", {
      id: 555777,
      email: "gdpr-target@example.com",
      first_name: "Erase",
      last_name: "Me",
    });
    await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...create.headers, "content-type": "application/json" })
      .send(create.raw.toString("utf8"))
      .expect(200);

    const redact = webhookDelivery("customers/redact", "del-redact-1", {
      shop_id: 777001,
      shop_domain: TEST_SHOP,
      customer: { id: 555777, email: "gdpr-target@example.com" },
      orders_to_redact: [],
    });
    await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...redact.headers, "content-type": "application/json" })
      .send(redact.raw.toString("utf8"))
      .expect(200);

    const rows = await env.db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.shopifyWebhookId, "del-customer-redact-target"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ redacted: true });
  });
});
