import { randomUUID } from "node:crypto";
import { eq, like } from "@profit/db";
import { backgroundJobs, failedJobs, stores, webhookLogs } from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestEnvironment,
  shopifyWebhookHeaders,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../test-support/harness";

/**
 * In-process load + concurrency suite (ADR 28). No external drivers (k6 etc.)
 * — CI-portable and dependency-free by design: supertest fires truly parallel
 * HTTP against the real middleware chain, PGlite isolates storage. It proves
 * the invariants load is famous for breaking:
 *   1. multi-tenant reads under concurrency never cross tenants;
 *   2. Shopify's duplicate-delivery burst is acked within budget and deduped
 *      to exactly one durable handoff (at-least-once → exactly-once effect);
 *   3. the fixed-window limiter saturates honestly per identity: a burst only
 *      burns its own key — neighbours are unaffected;
 *   4. p95 latency stays inside documented budgets (Shopify's ~5s webhook ack
 *      requirement gets generous-but-meaningful headroom).
 * Window-expiry recovery is a property of the cache TTL (unit-covered in
 * @profit/cache); here we assert correctness under burst contention, which no
 * waiting strategy can replace.
 */

const TENANT_PARALLELISM = 30;
const FLOOD_PARALLELISM = 30;
const LIMIT_BURST = 70;
/** Budgets: in-process+PGlite numbers; 5x headroom over Shopify's 5s ack budget. */
const READ_P95_BUDGET_MS = 1500;
const ACK_P95_BUDGET_MS = 1500;

function percentile95(durationsMs: readonly number[]): number {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

let env: TestEnvironment;
let tokenA = "";
let tokenB = "";
let storeAId = "";
let storeBId = "";

async function install(shop: string, code: string): Promise<void> {
  const res = await request(env.app).get(`/shopify/install?shop=${shop}`).expect(302);
  const state = new URL(res.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code, shop, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
}

async function login(shopifyUserId: string, shop: string, ip: string): Promise<string> {
  const sessionToken = await signShopifySessionToken({ shopifyUserId, shop });
  const res = await request(env.app)
    .post("/api/v1/auth/session")
    .set({ "X-Forwarded-For": ip })
    .send({ sessionToken })
    .expect(200);
  return res.body.data.accessToken as string;
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  await install(TEST_SHOP, "load-code-a");
  await install("load-second-store.myshopify.com", "load-code-b");
  const rows = await env.db.select().from(stores);
  storeAId = rows.find((row) => row.shopDomain === TEST_SHOP)!.id;
  storeBId = rows.find((row) => row.shopDomain === "load-second-store.myshopify.com")!.id;
  // Dedicated IPs keep warmup logins out of the burst identities below.
  tokenA = await login("load-owner-a", TEST_SHOP, "10.90.0.1");
  tokenB = await login("load-owner-b", "load-second-store.myshopify.com", "10.90.0.2");
}, 180_000);

afterAll(async () => {
  await env.close();
});

describe("multi-tenant concurrency", () => {
  it("sustains a mixed parallel read burst with hard tenant isolation and p95 inside budget", async () => {
    const durations: number[] = [];
    const responses = await Promise.all(
      Array.from({ length: TENANT_PARALLELISM }, async (_, i) => {
        const asA = i % 2 === 0;
        const started = performance.now();
        const res = await request(env.app)
          .get("/api/v1/store")
          .set("Authorization", `Bearer ${asA ? tokenA : tokenB}`);
        durations.push(performance.now() - started);
        return { res, asA };
      }),
    );

    for (const { res, asA } of responses) {
      expect(res.status).toBe(200);
      // The ONLY decisive assertion: each bearer gets exactly its own tenant.
      expect(res.body.data.store.id).toBe(asA ? storeAId : storeBId);
      expect(res.body.data.store.shopDomain).toBe(
        asA ? TEST_SHOP : "load-second-store.myshopify.com",
      );
    }
    expect(percentile95(durations)).toBeLessThan(READ_P95_BUDGET_MS);
  }, 120_000);
});

describe("webhook acknowledgement under duplicate-delivery flood", () => {
  it("acks every redelivery in budget and dedupes to exactly one durable handoff", async () => {
    const deliveryId = `flood-${randomUUID()}`;
    const rawBody = Buffer.from(
      JSON.stringify({ id: 424242, financial_status: "paid", total_price: "129.00" }),
      "utf8",
    );
    const headers = shopifyWebhookHeaders(TEST_SHOP, "orders/create", deliveryId, rawBody);

    const durations: number[] = [];
    // Shopify ships the payload as a JSON string; HMAC is byte-exact, so the
    // test must transmit identical bytes (supertest stringifies raw Buffers).
    const wireBody = rawBody.toString("utf8");
    const responses = await Promise.all(
      Array.from({ length: FLOOD_PARALLELISM }, async () => {
        const started = performance.now();
        const res = await request(env.app)
          .post("/shopify/webhooks")
          .set({ ...headers, "content-type": "application/json" })
          .send(wireBody);
        durations.push(performance.now() - started);
        return res;
      }),
    );

    // Shopify's contract: every redelivery gets a 2xx so retries stop.
    const outcomes: string[] = [];
    for (const res of responses) {
      expect(res.status).toBe(200);
      outcomes.push(res.body.data.outcome as string);
    }
    expect(outcomes.filter((outcome) => outcome === "processed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "duplicate")).toHaveLength(
      FLOOD_PARALLELISM - 1,
    );
    expect(percentile95(durations)).toBeLessThan(ACK_P95_BUDGET_MS);

    // Physical dedupe: one intake row…
    const logs = await env.db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.shopifyWebhookId, deliveryId));
    expect(logs).toHaveLength(1);
    // …and exactly one durable handoff keyed by the intake row (P12:
    // at-least-once delivery becomes an exactly-once-enqueued workflow).
    const log = logs[0]!;
    const handoffs = await env.db
      .select()
      .from(backgroundJobs)
      .where(like(backgroundJobs.idempotencyKey, `webhook:${log.id}%`));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toMatchObject({ storeId: storeAId, webhookLogId: log.id });

    // Nothing died on the way: zero dead-letter rows for this store.
    const dead = await env.db
      .select()
      .from(failedJobs)
      .where(eq(failedJobs.storeId, storeAId));
    expect(dead).toHaveLength(0);
  }, 180_000);
});

describe("rate-limit saturation under burst", () => {
  it("saturates one identity honestly while a neighbour stays fully served", async () => {
    // The midpoint math only holds if the window starts clean — dedicated IPs.
    const burnIp = { "X-Forwarded-For": "10.90.9.1" };
    const neighbourIp = { "X-Forwarded-For": "10.90.9.2" };

    const responses = await Promise.all(
      Array.from({ length: LIMIT_BURST }, () =>
        request(env.app)
          .post("/api/v1/auth/session")
          .set(burnIp)
          .send({ sessionToken: "flood-of-garbage-credentials" }),
      ),
    );
    for (const res of responses) {
      // Under contention the answer is either "judge credentials" (401) or
      // the typed limiter refusal (429) — never 5xx, never 200.
      expect([401, 429]).toContain(res.status);
      if (res.status === 429) {
        expect(res.body.errors[0].code).toBe("RATE_LIMITED");
      }
    }
    const rejected = responses.filter((res) => res.status === 429).length;
    const admitted = responses.length - rejected;
    // Fixed window of 60/hr: the 70-burst MUST overdraw it (at least 10 hit
    // 429), and the window must never admit beyond its max.
    expect(rejected).toBeGreaterThanOrEqual(LIMIT_BURST - 60);
    expect(admitted).toBeLessThanOrEqual(60);

    // Burst burns only its own key: the neighbour's first hit is judged on
    // credentials (401), proving per-identity isolation under saturation.
    const neighbour = await request(env.app)
      .post("/api/v1/auth/session")
      .set(neighbourIp)
      .send({ sessionToken: "flood-of-garbage-credentials" })
      .expect(401);
    expect(neighbour.body.errors[0].code).toBe("AUTHENTICATION_FAILED");
  }, 180_000);
});
