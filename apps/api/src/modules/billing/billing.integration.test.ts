import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "@profit/db";
import {
  actionExecutions,
  billingEvents,
  engagementEvents,
  notifications,
  plans,
  recommendations,
  shopifySessions,
  stores,
  subscriptions,
} from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestEnvironment,
  createBillingStubState,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type BillingStubState,
  type TestEnvironment,
} from "../../test-support/harness";

/**
 * /api/v1/billing (M5, P2/P7/P11): the charge flow end-to-end against the
 * REAL service stack — only Shopify's HTTP edge is stubbed (harness rule).
 * Merchant decisions never arrive by URL: the callback re-reads the charge
 * through the (stubbed) Admin API, mirroring production exactly.
 *
 * Plus the P2 request-chain gate: revenue actions 403 with structured
 * UPGRADE_REQUIRED / QUOTA_EXCEEDED while reads stay open.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";
let billing: BillingStubState;

const TRIAL_PLAN = "STARTER"; // install-provisioned plan (M1 contract)

async function provisionShop(shop: string, userHandle: string): Promise<string> {
  const installRes = await request(env.app).get(`/shopify/install?shop=${shop}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: `c-${userHandle}`, shop, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: userHandle, shop });
  const login = await request(env.app)
    .post("/api/v1/auth/session")
    .send({ sessionToken })
    .expect(200);
  return login.body.data.accessToken as string;
}

async function subRow(): Promise<typeof subscriptions.$inferSelect> {
  const rows = await env.db.select().from(subscriptions).where(eq(subscriptions.storeId, storeId));
  return rows[0]!;
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  billing = createBillingStubState();
  stubShopifyHttp({ billing });
  accessToken = await provisionShop(TEST_SHOP, "billing-owner");
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
});

afterAll(async () => {
  await env.close();
});

describe("read surface (billing:read)", () => {
  it("GET /overview bundles subscription, plan entitlements, live usage and access", async () => {
    const res = await request(env.app)
      .get("/api/v1/billing/overview")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const data = res.body.data;
    expect(data.subscription.status).toBe("TRIALING");
    expect(data.plan.code).toBe(TRIAL_PLAN);
    expect(data.plan.entitlements.quotas.aiCalls).toBe(100);
    expect(data.access).toEqual({ revenueActionsAllowed: true, blockedReason: null });
    expect(data.usage.meters).toHaveLength(4);
    expect(data.usage.status).toBe("TRIALING");
    const aiMeter = data.usage.meters.find((m: { meter: string }) => m.meter === "AI_CALLS");
    expect(aiMeter).toMatchObject({ used: 0, limit: 100 });
    expect(data.usage.window.from).toBeDefined();
    expect(data.usage.window.to).toBeDefined();
  });

  it("GET /plans answers the seeded catalog in price order, current plan marked", async () => {
    const res = await request(env.app)
      .get("/api/v1/billing/plans")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.plans.map((p: { code: string }) => p.code)).toEqual([
      "STARTER",
      "GROWTH",
      "PROFESSIONAL",
      "ENTERPRISE",
    ]);
    const state = await request(env.app)
      .get("/api/v1/billing/overview")
      .set("authorization", `Bearer ${accessToken}`);
    expect(res.body.data.currentPlanId).toBe(state.body.data.plan.id);
  });

  it("GET /history shows the install-trial ledger entry", async () => {
    const res = await request(env.app)
      .get("/api/v1/billing/history")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const types = (res.body.data as { type: string }[]).map((row) => row.type);
    expect(types).toContain("TRIAL_STARTED");
  });

  it("auth contract: 401 without a bearer token", async () => {
    await request(env.app).get("/api/v1/billing/overview").expect(401);
  });
});

describe("charge lifecycle (subscribe → callback → cancel)", () => {
  let chargeId = "";

  it("POST /subscribe validates the body strictly", async () => {
    await request(env.app)
      .post("/api/v1/billing/subscribe")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ planCode: "DIAMOND", interval: "MONTHLY" })
      .expect(400);
    await request(env.app)
      .post("/api/v1/billing/subscribe")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ planCode: "GROWTH" })
      .expect(400);
  });

  it("POST /subscribe creates a pending charge and returns the confirmation URL", async () => {
    const res = await request(env.app)
      .post("/api/v1/billing/subscribe")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ planCode: "GROWTH", interval: "MONTHLY" })
      .expect(201);
    expect(res.body.data.confirmationUrl).toContain("/admin/charges/");
    chargeId = res.body.data.chargeId as string;
    expect(chargeId.length).toBeGreaterThan(0);

    const row = await subRow();
    expect(row.status).toBe("CHARGE_PENDING");
    expect(row.shopifyChargeId).toBe(chargeId);
    expect(row.billingInterval).toBe("MONTHLY");

    // Shopify-side: the charge waits for the merchant decision (PENDING).
    expect(billing.liveSubscriptions).toHaveLength(1);
    expect(billing.liveSubscriptions[0]!.status).toBe("PENDING");
    expect(billing.liveSubscriptions[0]!.test).toBe(true); // harness flags dev-store charges test
  });

  it("GET /callback enforces its contract and never trusts the URL", async () => {
    await request(env.app).get("/api/v1/billing/callback").expect(400);
    await request(env.app).get("/api/v1/billing/callback?charge_id=nope").expect(404);
    // Still PENDING on Shopify → the row is untouched, bounce says "pending".
    const res = await request(env.app)
      .get(`/api/v1/billing/callback?charge_id=${chargeId}`)
      .expect(302);
    expect(res.headers["location"]).toBe(
      `https://${TEST_SHOP}/admin/apps/test_api_key?billing_state=pending`,
    );
    expect((await subRow()).status).toBe("CHARGE_PENDING");
  });

  it("DECLINED on Shopify sends the merchant back with a failed state and restores the trial", async () => {
    billing.liveSubscriptions[0]!.status = "DECLINED";
    const res = await request(env.app)
      .get(`/api/v1/billing/callback?charge_id=${chargeId}`)
      .expect(302);
    expect(res.headers["location"]).toContain("billing_state=declined");
    expect((await subRow()).status).toBe("TRIALING"); // trial still had days left
    const events = await env.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, storeId), eq(billingEvents.type, "CHARGE_DECLINED")));
    expect(events).toHaveLength(1);
  });

  it("ACTIVATED on Shopify flips the row ACTIVE, notifies, and records the growth milestone", async () => {
    // Re-subscribe after the decline (a fresh charge, like a merchant retry).
    const subscribe = await request(env.app)
      .post("/api/v1/billing/subscribe")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ planCode: "GROWTH", interval: "MONTHLY" })
      .expect(201);
    chargeId = subscribe.body.data.chargeId as string;
    billing.liveSubscriptions.find((s) => s.id.endsWith(chargeId))!.status = "ACTIVE";

    const res = await request(env.app)
      .get(`/api/v1/billing/callback?charge_id=${chargeId}`)
      .expect(302);
    expect(res.headers["location"]).toBe(
      `https://${TEST_SHOP}/admin/apps/test_api_key?billing_state=activated`,
    );

    const row = await subRow();
    expect(row.status).toBe("ACTIVE");
    expect(row.currentPeriodStart).not.toBeNull();
    expect(row.currentPeriodEnd).not.toBeNull();

    const mails = await env.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.storeId, storeId), eq(notifications.category, "BILLING")));
    expect(mails.some((m) => m.title === "Subscription activated")).toBe(true);

    const milestone = await env.db
      .select()
      .from(engagementEvents)
      .where(
        and(eq(engagementEvents.storeId, storeId), eq(engagementEvents.kind, "PAID_SUBSCRIPTION_STARTED")),
      );
    expect(milestone).toHaveLength(1);
  });

  it("double-subscribe onto an ACTIVE charge is refused (409-class 403 with reason)", async () => {
    const res = await request(env.app)
      .post("/api/v1/billing/subscribe")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ planCode: "GROWTH", interval: "MONTHLY" });
    expect(res.status).toBe(403);
  });

  it("POST /cancel cancels the charge idempotently at Shopify and honors the paid period", async () => {
    const res = await request(env.app)
      .post("/api/v1/billing/cancel")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toEqual({ cancelled: true });

    const row = await subRow();
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledAt).not.toBeNull();
    expect(row.currentPeriodEnd).not.toBeNull();

    const events = await env.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, storeId), eq(billingEvents.type, "CHARGE_CANCELLED")));
    expect(events).toHaveLength(1);

    // Second cancel is a typed conflict, not a crash or a duplicate event.
    const second = await request(env.app)
      .post("/api/v1/billing/cancel")
      .set("authorization", `Bearer ${accessToken}`);
    expect(second.status).toBe(403);
    const eventsAfter = await env.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, storeId), eq(billingEvents.type, "CHARGE_CANCELLED")));
    expect(eventsAfter).toHaveLength(1);
  });
});

describe("provider availability (never a simulated charge)", () => {
  const ORPHAN_SHOP = "no-token-store.myshopify.com";
  let orphanToken = "";

  it("subscribe on a store without a Shopify token answers 503 BILLING_UNAVAILABLE", async () => {
    orphanToken = await provisionShop(ORPHAN_SHOP, "orphan-owner");
    // The stripe of reality the provider factory needs: the OFFLINE token.
    const orphanStoreRows = await env.db.select().from(stores).where(eq(stores.shopDomain, ORPHAN_SHOP));
    const orphanStoreId = orphanStoreRows[0]!.id;
    await env.db
      .delete(shopifySessions)
      .where(and(eq(shopifySessions.storeId, orphanStoreId), eq(shopifySessions.sessionType, "OFFLINE")));

    const res = await request(env.app)
      .post("/api/v1/billing/subscribe")
      .set("authorization", `Bearer ${orphanToken}`)
      .send({ planCode: "GROWTH", interval: "MONTHLY" });
    expect(res.status).toBe(503);
    expect(res.body.errors[0].code).toBe("BILLING_UNAVAILABLE");
  });
});

describe("P2 subscription gate on revenue actions (reads stay open)", () => {
  async function forceStatus(status: string): Promise<void> {
    await env.db
      .update(subscriptions)
      .set({ status: status as typeof subscriptions.$inferSelect["status"], updatedAt: new Date() })
      .where(eq(subscriptions.storeId, storeId));
  }

  /** Full lifecycle reset — the earlier describes drove this store through ACTIVE/CANCELLED on GROWTH. */
  async function resetToTrialing(): Promise<void> {
    const starterRows = await env.db.select().from(plans).where(eq(plans.code, TRIAL_PLAN));
    await env.db
      .update(subscriptions)
      .set({
        planId: starterRows[0]!.id, // back to the install plan (20 automation-run quota)
        status: "TRIALING",
        trialEndsAt: new Date(Date.now() + 2 * 86_400_000),
        shopifyChargeId: null,
        billingInterval: null,
        graceEndsAt: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelledAt: null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.storeId, storeId));
  }

  async function insertAdvisoryRec(): Promise<string> {
    const rows = await env.db
      .insert(recommendations)
      .values({
        storeId,
        fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
        type: "RECOVER_ABANDONED_CART",
        agentId: "REVENUE_RECOVERY",
        ruleId: "cart.abandoned-recovery",
        title: "Recover recent abandoned carts",
        description: "Carts went cold and are within recovery range.",
        reasoning: ["point one", "point two"],
        priority: "HIGH",
        confidence: 80,
        riskLevel: "LOW",
        estimatedRevenueCents: 2_000,
        estimatedCostCents: 900,
        subjects: { checkoutTokens: ["t"] },
        actionType: "ADVISORY",
        actionParams: {},
        status: "PENDING_APPROVAL",
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning({ id: recommendations.id });
    return rows[0]!.id;
  }

  it("inactive subscription → 403 UPGRADE_REQUIRED on run + approve; reads unaffected", async () => {
    await forceStatus("TRIAL_EXPIRED");
    const recId = await insertAdvisoryRec();

    const run = await request(env.app)
      .post("/api/v1/recommendations/run")
      .set("authorization", `Bearer ${accessToken}`);
    expect(run.status).toBe(403);
    expect(run.body.errors[0].code).toBe("UPGRADE_REQUIRED");

    const approve = await request(env.app)
      .post(`/api/v1/recommendations/${recId}/approve`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({});
    expect(approve.status).toBe(403);
    expect(approve.body.errors[0].code).toBe("UPGRADE_REQUIRED");

    // Reads are never paywalled.
    await request(env.app)
      .get("/api/v1/recommendations")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    await request(env.app)
      .get("/api/v1/billing/plans")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
  });

  it("quota breach → 403 QUOTA_EXCEEDED with typed details; approve recovers when room returns", async () => {
    await resetToTrialing(); // window: installedAt → trialEndsAt (all seeded runs inside)

    // STARTER quota: 20 automation runs — fill the window (installedAt≈suite
    // boot, so runs stamp "now", right inside it) with started executions.
    const recId = await insertAdvisoryRec();
    const rows = Array.from({ length: 20 }, () => ({
      storeId,
      recommendationId: recId,
      actionType: "CREATE_DISCOUNT_CODE" as const,
      status: "SUCCEEDED" as const,
      idempotencyKey: createHash("sha256").update(randomUUID()).digest("hex"),
      toolRef: {},
      startedAt: new Date(),
    }));
    await env.db.insert(actionExecutions).values(rows);

    const freshRec = await insertAdvisoryRec();
    const approve = await request(env.app)
      .post(`/api/v1/recommendations/${freshRec}/approve`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({});
    expect(approve.status).toBe(403);
    expect(approve.body.errors[0].code).toBe("QUOTA_EXCEEDED");
    expect(approve.body.errors[0].details).toMatchObject({
      meter: "AUTOMATION_RUNS",
      limit: 20,
    });

    // Room returns (executions archived away in reality; here: cleared) → the SAME action succeeds.
    await env.db.delete(actionExecutions).where(eq(actionExecutions.storeId, storeId));
    await request(env.app)
      .post(`/api/v1/recommendations/${freshRec}/approve`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const milestone = await env.db
      .select()
      .from(engagementEvents)
      .where(
        and(
          eq(engagementEvents.storeId, storeId),
          eq(engagementEvents.kind, "FIRST_RECOMMENDATION_APPROVED"),
        ),
      );
    expect(milestone).toHaveLength(1);
  });
});
