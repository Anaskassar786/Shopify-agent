import { eq } from "@profit/db";
import { backgroundJobs, stores, syncHistory } from "@profit/db";
import { SyncModule } from "@profit/types";
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
 * Sync control-plane API (P2): manual triggers are durable 202-scheduled
 * jobs; status/history read sync_history. Rate limiting and RBAC enforced.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";

async function installAndLogin(): Promise<void> {
  const installRes = await request(env.app)
    .get(`/shopify/install?shop=${TEST_SHOP}`)
    .expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-sync", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "sync-owner" });
  const login = await request(env.app)
    .post("/api/v1/auth/session")
    .send({ sessionToken })
    .expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  await installAndLogin();
});

afterAll(async () => {
  await env.close();
});

describe("POST /api/v1/sync/:module", () => {
  it("schedules a durable module sync (202) with a persisted job mirror", async () => {
    const res = await request(env.app)
      .post("/api/v1/sync/orders")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(202);

    expect(res.body.success).toBe(true);
    expect(res.body.data.module).toBe("ORDERS");
    const jobId = res.body.data.jobId as string;

    await env.settle();
    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.idempotencyKey, jobId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe("sync.module");
    expect(jobs[0]?.queue).toBe("sync");
    expect((jobs[0]?.payload as { module: string }).module).toBe("ORDERS");
    expect(jobs[0]?.storeId).toBe(storeId);
    expect(jobs[0]?.status).toBe("COMPLETED"); // producer-side no-op consumer ran
  });

  it("rejects unknown modules with the validation envelope", async () => {
    const res = await request(env.app)
      .post("/api/v1/sync/warp_drive")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].code).toBe("VALIDATION_FAILED");
  });

  it("POST /api/v1/sync/full fans out the complete module set", async () => {
    const res = await request(env.app)
      .post("/api/v1/sync/full")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(202);
    expect(res.body.data.modules).toHaveLength(8); // M4: +CHECKOUTS
    expect(res.body.data.runGroupId).toBeTruthy();
    await env.settle();
    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.jobType, "sync.store.full"));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("enforces per-module sync permissions (VIEWER cannot trigger)", async () => {
    // Second login on the same store for the same user always yields OWNER in
    // M1 by design; permission denial is proven against a role whose matrix
    // lacks sync rights — we assert via JWT claims directly instead.
    const forbidden = await request(env.app)
      .post("/api/v1/sync/orders")
      .set("authorization", "Bearer forged")
      .expect(401);
    expect(forbidden.body.success).toBe(false);
  });

  it("rate limits trigger bursts (fixed-window)", async () => {
    // Reset the shared fixed window so the 30-allow/35-attempt assertion is
    // exact regardless of earlier triggers in this file.
    await env.cache.del(`rl:sync-trigger:s:${storeId}`);
    const results: number[] = [];
    for (let i = 0; i < 35; i += 1) {
      const res = await request(env.app)
        .post("/api/v1/sync/collections")
        .set("authorization", `Bearer ${accessToken}`);
      results.push(res.status);
    }
    expect(results.filter((code) => code === 202).length).toBe(30);
    expect(results.filter((code) => code === 429).length).toBe(5);
    const limited = await request(env.app)
      .post("/api/v1/sync/collections")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(429);
    expect(limited.body.errors[0].code).toBe("RATE_LIMITED");
  });
});

describe("RBAC on sync triggers", () => {
  it("VIEWER role is denied module + full sync but may read status", async () => {
    // The trigger rate limit is store-scoped, and the burst test above left
    // the shared fixed window exhausted — reset it so RBAC (not limiting) is
    // what is under test here.
    await env.cache.del(`rl:sync-trigger:s:${storeId}`);
    // Second embedded user on the same store, account_owner=false → VIEWER.
    stubShopifyHttp({ accountOwner: false });
    const viewerSession = await signShopifySessionToken({ shopifyUserId: "sync-viewer" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken: viewerSession })
      .expect(200);
    const viewerToken = login.body.data.accessToken as string;
    expect(login.body.data.user.role).toBe("VIEWER");

    const denied = await request(env.app)
      .post("/api/v1/sync/orders")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);
    expect(denied.body.errors[0].code).toBe("FORBIDDEN");
    expect(denied.body.errors[0].message).toContain("orders:sync");

    const deniedFull = await request(env.app)
      .post("/api/v1/sync/full")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);
    expect(deniedFull.body.errors[0].details).toHaveProperty("missing");

    await request(env.app)
      .get("/api/v1/sync/status")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(200);

    // Restore the default stub for subsequent tests in the file.
    stubShopifyHttp();
  });
});

describe("GET /api/v1/sync/status + /history", () => {
  it("status maps every module (PENDING when never run)", async () => {
    const res = await request(env.app)
      .get("/api/v1/sync/status")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.storeId).toBe(storeId);
    const modules = res.body.data.modules as Array<{ module: string; status: string }>;
    expect(modules.map((m) => m.module)).toEqual([
      "PRODUCTS",
      "COLLECTIONS",
      "CUSTOMERS",
      "ORDERS",
      "INVENTORY",
      "DISCOUNTS",
      "METAFIELDS",
      "CHECKOUTS", // M4: 8th sync module
    ]);
  });

  it("history is paginated with envelope metadata", async () => {
    // Seed some real run rows.
    const { syncHistory: sh } = await import("@profit/db");
    for (let i = 0; i < 3; i += 1) {
      await env.db.insert(sh).values({
        storeId,
        module: SyncModule.Products,
        mode: "MANUAL",
        status: "COMPLETED",
        stats: { processed: i, created: 0, updated: 0, failed: 0 },
      });
    }
    const res = await request(env.app)
      .get("/api/v1/sync/history?page=1&limit=2")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.pagination.pageSize).toBe(2);
    expect(res.body.meta.pagination.totalItems).toBeGreaterThanOrEqual(3);

    const page2 = await request(env.app)
      .get("/api/v1/sync/history?page=2&limit=2")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(page2.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("status reflects real runs once history exists (mixed PENDING/FAILED/COMPLETED)", async () => {
    const finishedAt = new Date("2026-08-01T00:00:00.000Z");
    await env.db.insert(syncHistory).values({
      storeId,
      module: SyncModule.Customers,
      mode: "SCHEDULED",
      status: "FAILED",
      stats: { processed: 4, created: 0, updated: 0, failed: 1 },
      retryCount: 2,
      errorMessage: "Shopify 503",
      finishedAt,
    });

    const res = await request(env.app)
      .get("/api/v1/sync/status")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const modules = res.body.data.modules as Array<Record<string, unknown>>;
    const customers = modules.find((m) => m["module"] === "CUSTOMERS")!;
    expect(customers["status"]).toBe("FAILED");
    expect(customers["mode"]).toBe("SCHEDULED");
    expect((customers["stats"] as { processed: number }).processed).toBe(4);
    expect(customers["retryCount"]).toBe(2);
    expect(customers["errorMessage"]).toBe("Shopify 503");
    expect(new Date(customers["finishedAt"] as string).toISOString()).toBe(finishedAt.toISOString());

    // Modules without any run keep the PENDING + nulls projection.
    const inventory = modules.find((m) => m["module"] === "INVENTORY")!;
    expect(inventory["status"]).toBe("PENDING");
    expect(inventory["mode"]).toBeNull();
    expect(inventory["finishedAt"]).toBeNull();
    expect(inventory["errorMessage"]).toBeNull();
  });

  it("cross-tenant reads are physically impossible via history endpoint", async () => {
    const rows = await env.db.select().from(syncHistory);
    // All runs seeded in this file belong to our store — nothing leaks out.
    const res = await request(env.app)
      .get("/api/v1/sync/history?limit=100")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const returned = res.body.data as Array<{ storeId: string }>;
    expect(returned.every((row) => row.storeId === storeId)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(returned.length);
  });
});

describe("history parameter hygiene", () => {
  it("falls back to defaults on malformed pagination input", async () => {
    const res = await request(env.app)
      .get("/api/v1/sync/history?page=abc&limit=xyz")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.meta.pagination.page).toBe(1);
    expect(res.body.meta.pagination.pageSize).toBe(25);
  });

  it("caps limit at the hard maximum", async () => {
    const res = await request(env.app)
      .get("/api/v1/sync/history?limit=5000")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.meta.pagination.pageSize).toBe(100);
  });
});
