import { desc, eq } from "@profit/db";
import { platformAdminActions, stores } from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  JobStatus,
  PlatformAdminAction,
  WorkflowNodeKind,
  WorkflowTriggerKind,
} from "@profit/types";
import {
  buildTestEnvironment,
  PLATFORM_ADMIN_KEY,
  shopifyWebhookHeaders,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../../test-support/harness";
import { DEFAULT_MAINTENANCE_MESSAGE } from "./ops-flags.service";

/**
 * Launch readiness ops control plane (ADR 37), proven end-to-end against the
 * REAL harness wiring (production composition parity):
 *
 *  1. Maintenance mode — platform kv flag + merchant-plane 503s with the
 *     operator message; the exempt set (session boot, legal, health, webhooks,
 *     admin bypass) stays up by construction; step-up-gated, fully audited.
 *  2. Per-merchant feature flags — `store_settings.featureOverrides` now has
 *     real evaluation points: provider-crossing AI writes and workflow
 *     mutations 503 FEATURE_DISABLED while reads stay readable.
 *  3. Job-queue ops view — pending/running/completed/failed/retries/DLQ read
 *     off the durable background_jobs mirror (correct even with Redis down).
 */

let env: TestEnvironment;
let storeId = "";
let accessToken = "";

const VALID_DEFINITION = {
  nodes: [
    { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: WorkflowTriggerKind.Manual } },
    { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "ops-suite" } },
  ],
  edges: [{ from: "trigger", to: "tag" }],
};

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-ops", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "ops-owner" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
});

afterAll(async () => {
  await env.close();
});

async function openSession(operatorId = "ops-launch"): Promise<string> {
  const res = await request(env.app)
    .post("/api/v1/admin/session")
    .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
    .send({ operatorId, reason: "launch readiness ops verification" })
    .expect(201);
  return res.body.data.token as string;
}

describe("maintenance mode (platform switch)", () => {
  it("reports maintenance as never-set, and the merchant plane runs normally", async () => {
    const flags = await request(env.app)
      .get("/api/v1/admin/ops/flags")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    expect(flags.body.data.maintenance).toBeNull();

    const storeRes = await request(env.app)
      .get("/api/v1/store")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(storeRes.body.data.store.shopDomain).toBe(TEST_SHOP);
  });

  it("refuses the toggle without a step-up session (401)", async () => {
    const res = await request(env.app)
      .patch("/api/v1/admin/ops/maintenance")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .send({ enabled: true, message: "nope", reason: "should not apply" });
    expect(res.status).toBe(401);
  });

  it("engages on the next merchant request with the operator's message; exempt surfaces stay up", async () => {
    const token = await openSession();
    const enabled = await request(env.app)
      .patch("/api/v1/admin/ops/maintenance")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ enabled: true, message: "Upgrading the data plane", reason: "migration 0009 deploy" })
      .expect(200);
    expect(enabled.body.data.maintenance).toMatchObject({
      enabled: true,
      message: "Upgrading the data plane",
      setBy: "ops-launch",
    });

    // Merchant data plane 503s with the typed envelope + operator message.
    const blocked = await request(env.app)
      .get("/api/v1/store")
      .set("authorization", `Bearer ${accessToken}`);
    expect(blocked.status).toBe(503);
    expect(blocked.body.errors[0].code).toBe("MAINTENANCE_MODE");
    expect(blocked.body.errors[0].message).toBe("Upgrading the data plane");
    expect(blocked.body.requestId).toBeDefined();

    const blockedAgain = await request(env.app)
      .get("/api/v1/customers")
      .set("authorization", `Bearer ${accessToken}`);
    expect(blockedAgain.status).toBe(503);
    expect(blockedAgain.body.errors[0].code).toBe("MAINTENANCE_MODE");

    // Exempt by construction (ADR 37):
    //  - session boot stays open (merchants must be able to see the notice,
    //    and host apps must keep re-authenticating).
    const sessionToken = await signShopifySessionToken({ shopifyUserId: "ops-owner" });
    await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
    //  - legal + health stay public.
    await request(env.app).get("/legal/privacy").expect(200);
    await request(env.app).get("/ready").expect(200);
    //  - the admin console is the operator bypass.
    await request(env.app)
      .get("/api/v1/admin/overview")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    //  - Shopify webhooks keep acking into durable intake (never drop events).
    const raw = Buffer.from(JSON.stringify({ id: 880001, title: "maintenance probe" }), "utf8");
    const headers = shopifyWebhookHeaders(TEST_SHOP, "products/update", "del-ops-maint-1", raw);
    await request(env.app)
      .post("/shopify/webhooks")
      .set({ ...headers, "content-type": "application/json" })
      .send(raw.toString("utf8"))
      .expect(200);
  });

  it("falls back to the default message when the operator sets none", async () => {
    const token = await openSession();
    await request(env.app)
      .patch("/api/v1/admin/ops/maintenance")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ enabled: true, message: null, reason: "message fallback check" })
      .expect(200);
    const blocked = await request(env.app)
      .get("/api/v1/store")
      .set("authorization", `Bearer ${accessToken}`);
    expect(blocked.status).toBe(503);
    expect(blocked.body.errors[0].message).toBe(DEFAULT_MAINTENANCE_MESSAGE);
  });

  it("recovers the merchant plane on disable and audits every write", async () => {
    const token = await openSession();
    await request(env.app)
      .patch("/api/v1/admin/ops/maintenance")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ enabled: false, message: null, reason: "migration 0009 complete" })
      .expect(200);

    await request(env.app)
      .get("/api/v1/store")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);

    const rows = await env.db
      .select()
      .from(platformAdminActions)
      .where(eq(platformAdminActions.action, PlatformAdminAction.SetMaintenanceMode))
      .orderBy(desc(platformAdminActions.createdAt));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toMatchObject({
      operatorId: "ops-launch",
      storeId: null,
      targetType: "platform_flags",
      targetId: "maintenance",
    });
    expect(rows[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("per-merchant feature flags", () => {
  it("reads default to nothing disabled; unknown stores 404", async () => {
    const initial = await request(env.app)
      .get(`/api/v1/admin/merchants/${storeId}/feature-flags`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    expect(initial.body.data.flags).toEqual({});

    await request(env.app)
      .get("/api/v1/admin/merchants/00000000-0000-0000-0000-000000000000/feature-flags")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(404);
  });

  it("gate-checks the write path: step-up, store existence, closed taxonomy, non-empty patch", async () => {
    const naked = await request(env.app)
      .patch(`/api/v1/admin/merchants/${storeId}/feature-flags`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .send({ flags: { aiDisabled: true }, reason: "no session" });
    expect(naked.status).toBe(401);

    const token = await openSession();
    await request(env.app)
      .patch("/api/v1/admin/merchants/00000000-0000-0000-0000-000000000000/feature-flags")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ flags: { aiDisabled: true }, reason: "ghost store" })
      .expect(404);

    const unknown = await request(env.app)
      .patch(`/api/v1/admin/merchants/${storeId}/feature-flags`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ flags: { aiDisabled: true, whiteLabel: true }, reason: "unknown key" });
    expect(unknown.status).toBe(400);

    const empty = await request(env.app)
      .patch(`/api/v1/admin/merchants/${storeId}/feature-flags`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ flags: {}, reason: "nothing to do" });
    expect(empty.status).toBe(400);
  });

  it("aiDisabled blocks provider-crossing writes while reads stay readable", async () => {
    const token = await openSession();
    const patched = await request(env.app)
      .patch(`/api/v1/admin/merchants/${storeId}/feature-flags`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ flags: { aiDisabled: true }, reason: "provider incident containment" })
      .expect(200);
    expect(patched.body.data.flags).toMatchObject({ aiDisabled: true });

    const run = await request(env.app)
      .post("/api/v1/recommendations/run")
      .set("authorization", `Bearer ${accessToken}`)
      .send({});
    expect(run.status).toBe(503);
    expect(run.body.errors[0].code).toBe("FEATURE_DISABLED");
    expect(run.body.errors[0].message).toContain("AI features");

    const ask = await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "How is revenue trending this week?" });
    expect(ask.status).toBe(503);
    expect(ask.body.errors[0].code).toBe("FEATURE_DISABLED");

    // Reads are never gated — a disabled feature hides no merchant data.
    await request(env.app)
      .get("/api/v1/ai/overview")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    await request(env.app)
      .get("/api/v1/recommendations")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
  });

  it("automationDisabled blocks workflow mutations with an audit trail", async () => {
    const token = await openSession();
    await request(env.app)
      .patch(`/api/v1/admin/merchants/${storeId}/feature-flags`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ flags: { automationDisabled: true }, reason: "runaway workflow containment" })
      .expect(200);

    const created = await request(env.app)
      .post("/api/v1/workflows")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ name: "blocked workflow", definition: VALID_DEFINITION });
    expect(created.status).toBe(503);
    expect(created.body.errors[0].code).toBe("FEATURE_DISABLED");
    expect(created.body.errors[0].message).toContain("Automation");

    // Workflow READS still work.
    await request(env.app)
      .get("/api/v1/workflows")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);

    const rows = await env.db
      .select()
      .from(platformAdminActions)
      .where(eq(platformAdminActions.action, PlatformAdminAction.SetFeatureFlags))
      .orderBy(desc(platformAdminActions.createdAt));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toMatchObject({ operatorId: "ops-launch", storeId, targetType: "store_settings" });
  });

  it("clearing the flags restores the write paths (merge is per-key last-write-wins)", async () => {
    const token = await openSession();
    const cleared = await request(env.app)
      .patch(`/api/v1/admin/merchants/${storeId}/feature-flags`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ flags: { aiDisabled: false, automationDisabled: false }, reason: "incident resolved" })
      .expect(200);
    expect(cleared.body.data.flags).toMatchObject({ aiDisabled: false, automationDisabled: false });

    await request(env.app)
      .post("/api/v1/copilot/ask")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ question: "How is revenue trending this week?" })
      .expect(201);

    await request(env.app)
      .post("/api/v1/workflows")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ name: "enabled again", definition: VALID_DEFINITION })
      .expect(201);
  });
});

describe("job-queue ops view", () => {
  it("reports the durable mirror with every status bucket present", async () => {
    // Seed one real durable job through the public write path, then converge.
    await request(env.app)
      .post("/api/v1/recommendations/run")
      .set("authorization", `Bearer ${accessToken}`)
      .send({})
      .expect(202);
    await env.settle();

    const res = await request(env.app)
      .get("/api/v1/admin/ops/jobs")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    const { byStatus, byQueue, failedLast24h, deadLettered, sampledAt } = res.body.data;
    for (const status of Object.values(JobStatus)) {
      expect(byStatus[status]).toBeDefined();
      expect(typeof byStatus[status]).toBe("number");
    }
    const total = Object.values(byStatus as Record<string, number>).reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(byQueue)).toBe(true);
    expect((byQueue as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(typeof failedLast24h).toBe("number");
    expect(typeof deadLettered).toBe("number");
    expect(typeof sampledAt).toBe("string");
  });
});
