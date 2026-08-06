import { eq } from "@profit/db";
import { auditLogs, stores, subscriptions, storeSettings } from "@profit/db";
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
 * Subscription + settings + onboarding API (P4/P11, M3). Trials auto-start at
 * install (M1 provisioning, STARTER plan, 3-day window from the seeded plan
 * catalog); start-trial is the honest recovery path for stores whose install
 * predates/plan-missed the provisioning. Settings PATCH is whitelisted +
 * merged; onboarding completion is durable + idempotent.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app)
    .get(`/shopify/install?shop=${TEST_SHOP}`)
    .expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-billing", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "billing-owner" });
  const login = await request(env.app)
    .post("/api/v1/auth/session")
    .send({ sessionToken })
    .expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
});

afterAll(async () => {
  await env.close();
});

describe("install-provisioned trial (M1 contract)", () => {
  it("install already created a STARTER TRIALING row; start-trial is an idempotent no-op (200)", async () => {
    const existing = await env.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.storeId, storeId));
    expect(existing).toHaveLength(1);
    expect(existing[0]?.status).toBe("TRIALING");

    const res = await request(env.app)
      .post("/api/v1/subscription/start-trial")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.id).toBe(existing[0]!.id);

    // No audit write on the no-op path — the trail only records real changes.
    const audits = await env.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "billing.subscription.trial_started"));
    expect(audits).toHaveLength(0);
  });

  it("GET /api/v1/subscription answers the joined plan + trial state", async () => {
    const res = await request(env.app)
      .get("/api/v1/subscription")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.subscription.status).toBe("TRIALING");
    expect(res.body.data.plan.code).toBe("STARTER");
    expect(res.body.data.plan.trialDays).toBe(3);
  });
});

describe("start-trial recovery path (row absent)", () => {
  it("creates the TRIALING row (201) with the plan window + audit trail", async () => {
    await env.db.delete(subscriptions).where(eq(subscriptions.storeId, storeId));

    const before = Date.now();
    const res = await request(env.app)
      .post("/api/v1/subscription/start-trial")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(201);
    expect(res.body.data.status).toBe("TRIALING");
    const endsMs = new Date(res.body.data.trialEndsAt as string).getTime();
    expect(endsMs - before).toBeGreaterThan(2.8 * 24 * 3600 * 1000);
    expect(endsMs - before).toBeLessThan(3.2 * 24 * 3600 * 1000);

    const audits = await env.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "billing.subscription.trial_started"));
    expect(audits).toHaveLength(1);

    const replay = await request(env.app)
      .post("/api/v1/subscription/start-trial")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(replay.body.data.id).toBe(res.body.data.id);
    const rows = await env.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.storeId, storeId));
    expect(rows).toHaveLength(1);
  });
});

describe("PATCH /api/v1/store/settings", () => {
  it("merges whitelisted groups and records the audit entry", async () => {
    const res = await request(env.app)
      .patch("/api/v1/store/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ branding: { primaryColor: "#6C5CE7" } })
      .expect(200);
    expect(res.body.data.branding.primaryColor).toBe("#6C5CE7");

    // Second patch merges — does not wipe the previous group.
    const merged = await request(env.app)
      .patch("/api/v1/store/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ aiPreferences: { autonomyMode: "SUGGEST" } })
      .expect(200);
    expect(merged.body.data.branding.primaryColor).toBe("#6C5CE7");
    expect(merged.body.data.aiPreferences.autonomyMode).toBe("SUGGEST");
  });

  it("rejects unknown groups, bad colors and empty payloads (strict whitelist)", async () => {
    for (const body of [
      { branding: { primaryColor: "red" } },
      { featureOverrides: { storeSyncEnabled: true } },
      {},
      { branding: { evil: "x" } },
    ]) {
      const res = await request(env.app)
        .patch("/api/v1/store/settings")
        .set("authorization", `Bearer ${accessToken}`)
        .send(body)
        .expect(400);
      expect(res.body.errors[0].code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("POST /api/v1/store/onboarding/complete", () => {
  it("sets the flag durably and idempotently", async () => {
    const first = await request(env.app)
      .post("/api/v1/store/onboarding/complete")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(first.body.data.onboardingCompletedAt).not.toBeNull();

    const again = await request(env.app)
      .post("/api/v1/store/onboarding/complete")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(again.body.data.onboardingCompletedAt).not.toBeNull();

    // GET /store now surfaces the completed flag for the wizard gate.
    const store = await request(env.app)
      .get("/api/v1/store")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(store.body.data.settings.onboardingCompletedAt).not.toBeNull();
  });
});

describe("settings read model", () => {
  it("store_settings row reflects everything end to end", async () => {
    const rows = await env.db
      .select()
      .from(storeSettings)
      .where(eq(storeSettings.storeId, storeId));
    expect(rows[0]?.onboardingCompletedAt).not.toBeNull();
    expect((rows[0]?.branding as { primaryColor?: string }).primaryColor).toBe("#6C5CE7");
  });
});
