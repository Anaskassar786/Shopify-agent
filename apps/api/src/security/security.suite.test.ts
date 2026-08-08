import { createHmac, createSecretKey, randomUUID } from "node:crypto";
import { and, eq, ne } from "@profit/db";
import { shopifyProducts, stores, withStoreScope } from "@profit/db";
import { SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_SECRET,
  API_KEY,
  APP_URL,
  buildTestEnvironment,
  PLATFORM_ADMIN_KEY,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../test-support/harness";

/**
 * Consolidated adversarial surface (M7 / P7 app-review baseline). Each gate
 * proves a negative the happy-path suites cannot: credential forgeries,
 * payload abuse, injection-shaped input, origin spoofing, admin-gate probing,
 * and tenant-claim spoofing. Everything runs against the REAL middleware
 * chain — Helmet, CORS, body parsers, guards, RLS — no test doubles.
 *
 * Coverage already owned by other suites (kept, not duplicated): OAuth state/
 * HMAC fraud (shopify.integration), webhook signature rejection + replay
 * dedupe (webhook-service.test), RLS cross-tenant reads/writes (tenant-rls),
 * rate-limit envelopes (auth/legal), refresh-token reuse (auth.integration).
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";
let otherStoreId = "";

async function install(shop: string, code: string): Promise<void> {
  const res = await request(env.app).get(`/shopify/install?shop=${shop}`).expect(302);
  const state = new URL(res.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code, shop, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  await install(TEST_SHOP, "sec-code-a");
  await install("sec-second-store.myshopify.com", "sec-code-b");
  const rows = await env.db.select().from(stores);
  storeId = rows.find((row) => row.shopDomain === TEST_SHOP)!.id;
  otherStoreId = rows.find((row) => row.shopDomain === "sec-second-store.myshopify.com")!.id;

  const sessionToken = await signShopifySessionToken({ shopifyUserId: "sec-owner" });
  const login = await request(env.app)
    .post("/api/v1/auth/session")
    .send({ sessionToken })
    .expect(200);
  accessToken = login.body.data.accessToken as string;

  // Attack-isolation fixtures: one own-store product, one foreign product.
  await withStoreScope(env.db, storeId, async (tx) => {
    await tx.insert(shopifyProducts).values({
      storeId,
      shopifyProductId: "sec-11",
      title: "Security Probe Lamp",
      handle: "security-probe-lamp",
      status: "ACTIVE",
    });
  });
  await withStoreScope(env.db, otherStoreId, async (tx) => {
    await tx.insert(shopifyProducts).values({
      storeId: otherStoreId,
      shopifyProductId: "sec-12",
      title: "Security Probe Mitt",
      handle: "security-probe-mitt",
      status: "ACTIVE",
    });
  });
}, 120_000);

afterAll(async () => {
  await env.close();
});

describe("transport hardening (headers + CORS)", () => {
  it("answers with the embedded-app CSP and never leaks server identity", async () => {
    const res = await request(env.app).get("/live").expect(200);
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("frame-ancestors https://admin.shopify.com");
    expect(csp).toContain("*.myshopify.com");
    expect(csp).toContain("script-src 'self' https://cdn.shopify.com");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-site");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("denies cross-origin browser traffic while honoring the first-party app origin", async () => {
    const hostile = await request(env.app).get("/live").set("Origin", "https://evil.example");
    expect(hostile.headers["access-control-allow-origin"]).not.toBe("https://evil.example");

    const preflight = await request(env.app)
      .options("/api/v1/auth/me")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");
    expect(preflight.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    expect(preflight.headers["access-control-allow-credentials"]).not.toBe("true");

    const allowed = await request(env.app).get("/live").set("Origin", APP_URL);
    expect(allowed.headers["access-control-allow-origin"]).toBe(APP_URL);
  });
});

describe("payload abuse boundaries", () => {
  it("rejects over-budget JSON bodies with the typed 413 envelope (not a 500)", async () => {
    const huge = { sessionToken: "a".repeat(1_200_000) };
    const res = await request(env.app)
      .post("/api/v1/auth/session")
      .set({ "X-Forwarded-For": "10.88.0.1" })
      .send(huge)
      .expect(413);
    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects malformed JSON with the typed 400 envelope", async () => {
    const res = await request(env.app)
      .post("/api/v1/auth/session")
      .set({ "Content-Type": "application/json", "X-Forwarded-For": "10.88.0.2" })
      .send("{\"sessionToken\":")
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].code).toBe("VALIDATION_FAILED");
    expect(res.body.errors[0].message).toBe("Malformed JSON body");
  });
});

describe("credential forgery resistance", () => {
  it("refuses garbage, wrong-secret, forged alg=none, and expired access tokens", async () => {
    await request(env.app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer garbage.token.value")
      .expect(401);

    const wrongSecret = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(randomUUID())
      .setAudience("profit-tool-ai")
      .setIssuer("profit-api")
      .sign(createSecretKey(Buffer.from("attacker-controlled-secret", "utf8")));
    await request(env.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${wrongSecret}`)
      .expect(401);

    // A hand-crafted "none" token must die on the pinned HS256 allowlist.
    const noneToken = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: randomUUID(), iss: "profit-api", exp: 9_999_999_999 })).toString("base64url"),
      "",
    ].join(".");
    await request(env.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${noneToken}`)
      .expect(401);

    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(randomUUID())
      .setAudience("profit-tool-ai")
      .setIssuer("profit-api")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(createSecretKey(Buffer.from(ACCESS_SECRET, "utf8")));
    const res = await request(env.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expired}`)
      .expect(401);
    expect(res.body.errors[0].code).toBe("AUTHENTICATION_FAILED");

    // Control: the real token still passes — the gate is discriminating.
    await request(env.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
  });

  it("refuses Shopify session tokens signed for a different app audience", async () => {
    const foreignAudience = await new SignJWT({ sub: "sec-owner", sid: "sid-1", dest: `https://${TEST_SHOP}` })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(`https://${TEST_SHOP}/admin`)
      .setAudience("someone-elses-api-key")
      .setIssuedAt()
      .setExpirationTime("300s")
      .setJti(randomUUID())
      .sign(createSecretKey(Buffer.from("test_api_secret", "utf8")));
    const res = await request(env.app)
      .post("/api/v1/auth/session")
      .set({ "X-Forwarded-For": "10.88.0.3" })
      .send({ sessionToken: foreignAudience })
      .expect(401);
    expect(res.body.errors[0].code).toBe("AUTHENTICATION_FAILED");
    expect(API_KEY).not.toBe("someone-elses-api-key");
  });
});

describe("injection-shaped input on authenticated surfaces", () => {
  it("global search treats SQL-shaped strings as inert text and never crosses tenants", async () => {
    for (const payload of ["' OR '1'='1", "%'; DROP TABLE stores;--", "\" UNION SELECT * FROM stores;\""]) {
      const res = await request(env.app)
        .get(`/api/v1/search?q=${encodeURIComponent(payload)}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.data.groups.products.items).toHaveLength(0);
      expect(res.body.data.groups.customers.items).toHaveLength(0);
      expect(res.body.data.groups.orders.items).toHaveLength(0);
    }

    // The schema survived the probes and isolation still holds: own row only.
    const hits = await request(env.app)
      .get(`/api/v1/search?q=${encodeURIComponent("Security Probe")}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(hits.body.data.groups.products.items).toHaveLength(1);
    expect(hits.body.data.groups.products.items[0].title).toBe("Security Probe Lamp");

    const physical = await env.db
      .select()
      .from(shopifyProducts)
      .where(and(eq(shopifyProducts.title, "Security Probe Mitt"), ne(shopifyProducts.storeId, storeId)));
    expect(physical).toHaveLength(1);

    const allStores = await env.db.select().from(stores);
    expect(allStores.length).toBeGreaterThanOrEqual(2);
  });

  it("tenant identity comes from the verified claim ONLY — headers and query cannot spoof it", async () => {
    const res = await request(env.app)
      .get(`/api/v1/store?storeId=${otherStoreId}`)
      .set({ Authorization: `Bearer ${accessToken}`, "x-store-id": otherStoreId, "x-tenant-id": otherStoreId })
      .expect(200);
    expect(res.body.data.store.id).toBe(storeId);
    expect(res.body.data.store.shopDomain).toBe(TEST_SHOP);
  });
});

describe("platform-admin gate probing", () => {
  it("denies missing and wrong operator keys on the access-review surface", async () => {
    const noKey = await request(env.app)
      .get("/api/v1/admin/access-review/sessions")
      .expect(401);
    expect(noKey.body.errors[0].code).toBe("AUTHENTICATION_FAILED");

    const wrongKey = await request(env.app)
      .get("/api/v1/admin/access-review/sessions")
      .set("x-platform-admin-key", `${PLATFORM_ADMIN_KEY}-forged`)
      .expect(401);
    expect(wrongKey.body.errors[0].code).toBe("AUTHENTICATION_FAILED");

    // Control: the real operator key reaches the read model.
    const okRes = await request(env.app)
      .get("/api/v1/admin/access-review/sessions")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    expect(okRes.body.success).toBe(true);
  });
});

describe("uniform failure envelopes", () => {
  it("unknown API routes answer 404 JSON, and HMAC failures never disclose internals", async () => {
    const unknown = await request(env.app).get("/api/v1/definitely-not-a-route").expect(404);
    expect(unknown.body.success).toBe(false);
    expect(unknown.body.errors[0].code).toBe("NOT_FOUND");

    const rawBody = Buffer.from(JSON.stringify({ id: 1 }), "utf8");
    const forged = await request(env.app)
      .post("/shopify/webhooks")
      .set({
        "x-shopify-shop-domain": TEST_SHOP,
        "x-shopify-topic": "orders/create",
        "x-shopify-webhook-id": randomUUID(),
        "x-shopify-hmac-sha256": createHmac("sha256", "attacker-secret").update(rawBody).digest("base64"),
        "content-type": "application/json",
      })
      .send(rawBody.toString("utf8"))
      .expect(401);
    expect(forged.body.errors[0].code).toBe("AUTHENTICATION_FAILED");
    expect(JSON.stringify(forged.body)).not.toContain("test_api_secret");
  });
});
