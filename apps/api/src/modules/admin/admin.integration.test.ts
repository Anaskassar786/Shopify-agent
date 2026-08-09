import express from "express";
import { and, eq, isNull } from "@profit/db";
import { auditLogs, stores } from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit.service";
import { errorHandlerMiddleware } from "../../middleware/error-handler.middleware";
import { adminRouter } from "./admin.router";
import {
  buildTestEnvironment,
  PLATFORM_ADMIN_KEY,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../../test-support/harness";

/**
 * /api/v1/admin (M5 Super Admin v1, P12): key-gated, constant-time, fully
 * audited, read-only. The panel never piggybacks tenant JWTs — an operator
 * key alone authorizes, and every request lands in the audit stream with a
 * NULL store (platform action).
 */

let env: TestEnvironment;
let accessToken = "";

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-admin", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "admin-suite-merchant" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  accessToken = login.body.data.accessToken as string;
});

afterAll(async () => {
  await env.close();
});

describe("key gate", () => {
  it("401 without a key, 401 with a wrong key — timing-safe compare, no tenant JWT fallback", async () => {
    const noKey = await request(env.app).get("/api/v1/admin/overview");
    expect(noKey.status).toBe(401);
    const wrongKey = await request(env.app)
      .get("/api/v1/admin/overview")
      .set("x-platform-admin-key", "not-the-key");
    expect(wrongKey.status).toBe(401);
    // A valid tenant JWT is NOT an admin credential (separate trust domain by design).
    const jwtOnly = await request(env.app)
      .get("/api/v1/admin/overview")
      .set("authorization", `Bearer ${accessToken}`);
    expect(jwtOnly.status).toBe(401);
  });

  it("503 with a typed error when the panel is unconfigured (never silently open)", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/v1/admin",
      adminRouter({
        db: env.db,
        platformAdminKey: undefined,
        audit: new AuditService(env.db, env.logger),
      }),
    );
    app.use(errorHandlerMiddleware(env.logger));
    const res = await request(app).get("/api/v1/admin/overview");
    expect(res.status).toBe(503);
    expect(res.body.errors[0].code).toBe("MAINTENANCE_MODE");
  });
});

describe("read-only observability", () => {
  it("GET /overview returns the owner dashboard + activation funnel", async () => {
    const res = await request(env.app)
      .get("/api/v1/admin/overview")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    const { dashboard, funnel } = res.body.data;
    expect(dashboard.merchants.total).toBeGreaterThanOrEqual(1);
    expect(dashboard.merchants.active).toBeGreaterThanOrEqual(1);
    expect(dashboard.subscriptions.trialing).toBeGreaterThanOrEqual(1);
    expect(dashboard).toHaveProperty("modeledMrrCents");
    expect(dashboard).toHaveProperty("modeledArrCents");
    expect(dashboard).toHaveProperty("ai");
    expect(dashboard).toHaveProperty("system");
    expect(Array.isArray(funnel)).toBe(true);
    expect(funnel.map((row: { kind: string }) => row.kind)).toContain("STORE_CONNECTED");
    expect(funnel[0].conversionFromPreviousPct).toBeNull();
  });

  it("GET /merchants pages the cross-tenant read model", async () => {
    const res = await request(env.app)
      .get("/api/v1/admin/merchants?page=1&pageSize=10")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const ours = res.body.data.find((row: { shopDomain: string }) => row.shopDomain === TEST_SHOP);
    expect(ours).toBeDefined();
    expect(ours.planCode).toBe("STARTER");
    expect(ours.subscriptionStatus).toBe("TRIALING");
    expect(ours).toHaveProperty("aiCostMicrosLast30d");
    expect(ours).toHaveProperty("attributedRevenueCents");

    const page = await request(env.app)
      .get("/api/v1/admin/merchants?page=1&pageSize=1")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    expect(page.body.data).toHaveLength(1);
  });

  it("GET /ai-usage returns the per-store cost ranking shape", async () => {
    const res = await request(env.app)
      .get("/api/v1/admin/ai-usage")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("every accepted admin request is audit-logged as a platform action (store null)", async () => {
    await request(env.app)
      .get("/api/v1/admin/ai-usage")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    const rows = await env.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "platform.admin.get"), isNull(auditLogs.storeId)));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((row) => String(row.entityId).includes("/ai-usage"))).toBe(true);
  });
});
