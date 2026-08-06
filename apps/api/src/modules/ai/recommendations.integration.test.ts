import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { and, eq } from "@profit/db";
import {
  actionExecutions,
  aiRuns,
  backgroundJobs,
  recommendations,
  recommendationEvidence,
  recommendationEvents,
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
 * AI API surface (P3 human approval + P9 command center). Recommendations are
 * seeded straight into the REAL schema (the decision service + state machine
 * are proven in @profit/ai's own suites); this suite proves the HTTP plane:
 * envelope shapes, filters, RBAC, approval → execution → queue dispatch,
 * idempotent manual runs, and the two overview aggregates.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";

const OWNER_UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

async function insertRec(
  overrides: Partial<typeof recommendations.$inferInsert> = {},
): Promise<string> {
  const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
  const rows = await env.db
    .insert(recommendations)
    .values({
      storeId,
      fingerprint,
      type: "RECOVER_ABANDONED_CART",
      agentId: "REVENUE_RECOVERY",
      ruleId: "cart.abandoned-recovery",
      title: "Recover Mia's abandoned cart",
      description: "A shopper left $48.00 behind 9 hours ago.",
      reasoning: ["Checkout abandoned 9h ago", "Recovery within 24h converts at 2.4%"],
      priority: "HIGH",
      confidence: 85,
      riskLevel: "LOW",
      estimatedRevenueCents: 1_152,
      estimatedCostCents: 960,
      subjects: { checkoutTokens: ["tok-api-1"] },
      actionType: "SEND_RECOVERY_EMAIL",
      actionParams: { template: "RECOVERY", checkoutToken: "tok-api-1", discountPercent: 10 },
      status: "PENDING_APPROVAL",
      ...overrides,
    })
    .returning({ id: recommendations.id });
  const id = rows[0]!.id;
  await env.db.insert(recommendationEvidence).values({
    storeId,
    recommendationId: id,
    snapshot: {
      computedAt: new Date().toISOString(),
      facts: ["cart total $48.00", "9 hours abandoned"],
      estimates: { recoveryRatePct: 2.4 },
      model: { provider: "gemini", promptId: "agent.revenue_recovery", promptVersion: "v1" },
    },
  });
  await env.db.insert(recommendationEvents).values({
    storeId,
    recommendationId: id,
    event: "CREATED",
    actorType: "AI",
    toStatus: "PENDING_APPROVAL",
    details: { ruleId: "cart.abandoned-recovery", confidence: 85 },
  });
  return id;
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
    .query(signOauthCallback({ code: "c-ai", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "ai-owner" });
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

describe("GET /api/v1/recommendations", () => {
  it("lists with envelope + pagination meta, filtered by status/priority/type", async () => {
    const empty = await request(env.app)
      .get("/api/v1/recommendations")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.meta.pagination.totalItems).toBe(0);

    const recId = await insertRec();
    await insertRec({ status: "EXECUTED", priority: "MEDIUM", type: "RESTOCK" });

    const all = await request(env.app)
      .get("/api/v1/recommendations")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(all.body.meta.pagination.totalItems).toBe(2);

    const pending = await request(env.app)
      .get("/api/v1/recommendations?status=PENDING_APPROVAL")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(pending.body.data).toHaveLength(1);
    expect(pending.body.data[0].id).toBe(recId);
    expect(pending.body.data[0].status).toBe("PENDING_APPROVAL");

    const highOnly = await request(env.app)
      .get("/api/v1/recommendations?priority=HIGH")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(highOnly.body.data).toHaveLength(1);

    const restockOnly = await request(env.app)
      .get("/api/v1/recommendations?type=RESTOCK")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(restockOnly.body.data).toHaveLength(1);
    expect(restockOnly.body.data[0].type).toBe("RESTOCK");
  });

  it("rejects a bogus status filter with the validation envelope", async () => {
    const res = await request(env.app)
      .get("/api/v1/recommendations?status=SOMETIMES")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(400);
    expect(res.body.errors[0].code).toBe("VALIDATION_FAILED");
  });
});

describe("GET /api/v1/recommendations/:id", () => {
  it("returns the detail with evidence snapshot and event timeline", async () => {
    const recId = await insertRec();
    const res = await request(env.app)
      .get(`/api/v1/recommendations/${recId}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.id).toBe(recId);
    expect(res.body.data.title).toContain("abandoned cart");
    expect(res.body.data.evidence.facts).toContain("cart total $48.00");
    expect(res.body.data.evidence.model.promptVersion).toBe("v1");
    const events = res.body.data.events as Array<{ event: string }>;
    expect(events.map((entry) => entry.event)).toContain("CREATED");
    expect(res.body.data.executions).toEqual([]);
  });

  it("404s an unknown id (tenant-safe: other stores' ids do not exist here)", async () => {
    await request(env.app)
      .get(`/api/v1/recommendations/${randomUUID()}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(404);
  });
});

describe("POST /api/v1/recommendations/:id/approve", () => {
  it("transitions to APPROVED, creates a PENDING execution and dispatches the job", async () => {
    const recId = await insertRec();
    const res = await request(env.app)
      .post(`/api/v1/recommendations/${recId}/approve`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.status).toBe("APPROVED");

    const executions = await env.db
      .select()
      .from(actionExecutions)
      .where(and(eq(actionExecutions.recommendationId, recId), eq(actionExecutions.status, "PENDING")));
    expect(executions).toHaveLength(1);

    await env.settle();
    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.idempotencyKey, `aiexec:${executions[0]!.id}`));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobType).toBe("ai.action.execute.email");
    expect(jobs[0]!.status).toBe("COMPLETED");
  });

  it("double-approve is a 409 (state machine enforced over HTTP)", async () => {
    const recId = await insertRec();
    await request(env.app)
      .post(`/api/v1/recommendations/${recId}/approve`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const second = await request(env.app)
      .post(`/api/v1/recommendations/${recId}/approve`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(409);
    expect(second.body.errors[0].code).toBe("CONFLICT");
  });

  it("advisory recommendations execute inline (no execution job)", async () => {
    const recId = await insertRec({
      type: "REVENUE_DECLINE_REVIEW",
      actionType: "ADVISORY",
      actionParams: { note: "review pricing" },
      status: "PENDING_APPROVAL",
    });
    const res = await request(env.app)
      .post(`/api/v1/recommendations/${recId}/approve`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.status).toBe("EXECUTED");
    const executions = await env.db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.recommendationId, recId));
    expect(executions).toHaveLength(0);
  });
});

describe("POST /api/v1/recommendations/:id/reject", () => {
  it("records the rejection with the merchant's reason (learning loop input)", async () => {
    const recId = await insertRec();
    const res = await request(env.app)
      .post(`/api/v1/recommendations/${recId}/reject`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({ reason: "Discounting hurts my brand" })
      .expect(200);
    expect(res.body.data.status).toBe("REJECTED");
    const events = await env.db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.recommendationId, recId));
    const rejected = events.find((entry) => entry.event === "REJECTED");
    expect(rejected).toBeDefined();
  });

  it("approve-after-reject is a 409 (terminal state)", async () => {
    const recId = await insertRec();
    await request(env.app)
      .post(`/api/v1/recommendations/${recId}/reject`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    await request(env.app)
      .post(`/api/v1/recommendations/${recId}/approve`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(409);
  });

  it("rejects an over-long reason with the validation envelope", async () => {
    const recId = await insertRec();
    const res = await request(env.app)
      .post(`/api/v1/recommendations/${recId}/reject`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({ reason: "x".repeat(501) })
      .expect(400);
    expect(res.body.errors[0].code).toBe("VALIDATION_FAILED");
  });
});

describe("POST /api/v1/recommendations/run", () => {
  it("queues a manual run (202) and dedupes inside the minute bucket", async () => {
    const first = await request(env.app)
      .post("/api/v1/recommendations/run")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(202);
    expect(first.body.data.jobId).toContain(`ai:manual:${storeId}:`);
    const second = await request(env.app)
      .post("/api/v1/recommendations/run")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(202);
    expect(second.body.data.jobId).toBe(first.body.data.jobId);

    await env.settle();
    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.idempotencyKey, first.body.data.jobId as string));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobType).toBe("ai.run");
    const payload = jobs[0]!.payload as { trigger: string; requestedByUserId: string };
    expect(payload.trigger).toBe("MANUAL");
    expect(payload.requestedByUserId).toBeDefined();
  });
});

describe("GET /api/v1/ai/overview", () => {
  it("zero state before the first run, then aggregates after a run row exists", async () => {
    // A fresh store other than the seeded one: its overview must be the typed zero state.
    const res = await request(env.app)
      .get("/api/v1/ai/overview")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    // This store HAS recommendations by now but no ai_runs row yet.
    expect(res.body.data.engine.lastRunAt).toBeNull();
    expect(res.body.data.engine.runsLast7d).toBe(0);
    expect(res.body.data.open.pendingApproval).toBeGreaterThanOrEqual(1);

    await env.db.insert(aiRuns).values({
      storeId,
      trigger: "SCHEDULED",
      status: "COMPLETED",
      storeHealthScore: 68,
      storeHealthBreakdown: { components: [{ id: "revenueTrend", score: 60, weight: 25 }] },
      agentsPlanned: 5,
      agentsCompleted: 1,
      recommendationsCreated: 1,
      duplicatesSkipped: 0,
      usage: { calls: 1, inputTokens: 950, outputTokens: 210, costMicros: 187 },
      startedAt: new Date(Date.now() - 3_600_000),
      finishedAt: new Date(Date.now() - 3_540_000),
    });

    const after = await request(env.app)
      .get("/api/v1/ai/overview")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.data.engine.lastRunStatus).toBe("COMPLETED");
    expect(after.body.data.engine.runsLast7d).toBe(1);
    expect(after.body.data.engine.costMicrosLast7d).toBe(187);
    expect(after.body.data.health.score).toBe(68);
    expect(after.body.data.recentEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/v1/automation/overview", () => {
  it("reflects the merchant policy from store settings + the execution ledger", async () => {
    const before = await request(env.app)
      .get("/api/v1/automation/overview")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(before.body.data.policy.mode).toBe("MANUAL");

    await request(env.app)
      .patch("/api/v1/store/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({
        automationPreferences: {
          mode: "SEMI_AUTOMATIC",
          abandonedCart: { enabled: true, delayHours: 10, minCartValueCents: 2_500, discountPercent: 15 },
        },
      })
      .expect(200);

    const after = await request(env.app)
      .get("/api/v1/automation/overview")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.data.policy.mode).toBe("SEMI_AUTOMATIC");
    expect(after.body.data.policy.abandonedCartDelayHours).toBe(10);
    expect(after.body.data.policy.abandonedCartDiscountPercent).toBe(15);
    expect(after.body.data.executions.length).toBeGreaterThanOrEqual(1); // approve-test ledger entry
  });
});

describe("RBAC", () => {
  it("VIEWER reads recommendations but cannot decide, run, or read automation", async () => {
    stubShopifyHttp({ accountOwner: false });
    const viewerSession = await signShopifySessionToken({ shopifyUserId: "ai-viewer" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken: viewerSession })
      .expect(200);
    const viewerToken = login.body.data.accessToken as string;

    await request(env.app)
      .get("/api/v1/recommendations")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(200);

    const recId = await insertRec();
    const denied = await request(env.app)
      .post(`/api/v1/recommendations/${recId}/approve`)
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);
    expect(denied.body.errors[0].code).toBe("FORBIDDEN");

    await request(env.app)
      .post("/api/v1/recommendations/run")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);

    await request(env.app)
      .get("/api/v1/automation/overview")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);

    stubShopifyHttp(); // restore owner mapping for any later suites sharing the stubber
  });
});
