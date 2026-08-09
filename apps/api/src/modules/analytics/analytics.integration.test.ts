import { createHash, randomUUID } from "node:crypto";
import { eq } from "@profit/db";
import { aiCallLogs, recommendationOutcomes, recommendations, stores } from "@profit/db";
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
 * GET /api/v1/analytics/roi (M5, P11 ROI reporting): the value ledger behind
 * the Billing page — measured attribution vs metered AI cost, windowed.
 */

const DAY = 24 * 3_600_000;

let env: TestEnvironment;
let accessToken = "";
let storeId = "";

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-roi", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "roi-owner" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;

  const recRows = await env.db
    .insert(recommendations)
    .values({
      storeId,
      fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      type: "RECOVER_ABANDONED_CART",
      agentId: "REVENUE_RECOVERY",
      ruleId: "cart.abandoned-recovery",
      title: "Recover recent abandoned carts",
      description: "Recovery email sent, impact measured.",
      reasoning: ["point one", "point two"],
      priority: "HIGH",
      confidence: 88,
      riskLevel: "LOW",
      estimatedRevenueCents: 18_000,
      estimatedCostCents: 900,
      subjects: { checkoutTokens: ["t"] },
      actionType: "SEND_RECOVERY_EMAIL",
      actionParams: {},
      status: "MEASURED",
      expiresAt: new Date(Date.now() + 7 * DAY),
    })
    .returning({ id: recommendations.id });
  await env.db.insert(recommendationOutcomes).values({
    storeId,
    recommendationId: recRows[0]!.id,
    method: "CHECKOUT_TOKEN",
    windowDays: 14,
    attributedOrdersCount: 3,
    attributedRevenueCents: 24_600,
    measuredAt: new Date(Date.now() - 2 * DAY),
  });
  await env.db.insert(aiCallLogs).values({
    storeId,
    agentId: "REVENUE_RECOVERY",
    provider: "GEMINI",
    model: "gemini-2.5-pro",
    modelTier: "STANDARD",
    promptId: "recovery.plan",
    promptVersion: "1",
    status: "SUCCEEDED",
    inputTokens: 120,
    outputTokens: 80,
    costMicros: 5_000,
    latencyMs: 640,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
  });
});

afterAll(async () => {
  await env.close();
});

describe("GET /api/v1/analytics/roi", () => {
  it("answers the 30-day value ledger with methodology-shaped numbers", async () => {
    const res = await request(env.app)
      .get("/api/v1/analytics/roi?windowDays=30")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const data = res.body.data;
    expect(data.windowDays).toBe(30);
    expect(data.outcomes).toEqual({
      attributedRevenueCents: 24_600,
      attributedOrdersCount: 3,
      measuredRecommendations: 1,
    });
    expect(data.cost).toEqual({ micros: 5_000, calls: 1 });
    expect(data.roiMultiple).toBe(4_920_000); // 24_600c × 1e6 / 5_000 micros
    expect(data.pipeline).toHaveProperty("openRecommendations");
    expect(data.pipeline).toHaveProperty("openEstimatedRevenueCents");
    expect(data.acceptanceRatePct).toBeNull(); // no decisions in the window
  });

  it("defaults to the 30-day window and accepts 90", async () => {
    const res = await request(env.app)
      .get("/api/v1/analytics/roi")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.windowDays).toBe(30);
    const wide = await request(env.app)
      .get("/api/v1/analytics/roi?windowDays=90")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(wide.body.data.windowDays).toBe(90);
  });

  it("rejects invalid windows (400) and anonymous callers (401)", async () => {
    const res = await request(env.app)
      .get("/api/v1/analytics/roi?windowDays=7")
      .set("authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
    await request(env.app).get("/api/v1/analytics/roi").expect(401);
  });
});
