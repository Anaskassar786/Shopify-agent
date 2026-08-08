import { eq, stores } from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformAdminAction } from "@profit/types";
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
 * M7 SOC-2-lite access review: the admin plane's read-only evidence surface —
 * per-store members × roles × permission breadth, live access overrides,
 * store-bound operator actions, and the global operator-session ledger. Key
 * gate only (it is a READ), but every row is real: flows executed through the
 * public API during setup, then read back here.
 */

let env: TestEnvironment;
let storeId = "";
let ownerEmail = "";

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-ar1", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "ar-owner" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  ownerEmail = login.body.data.user.email as string;
  storeId = (await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP)))[0]!.id;

  // Real write flows the review must surface: session open → trial extension → grant override.
  const session = (
    await request(env.app)
      .post("/api/v1/admin/session")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .send({ operatorId: "ops-review", reason: "access review verification" })
      .expect(201)
  ).body.data.token as string;
  await request(env.app)
    .post(`/api/v1/admin/merchants/${storeId}/trial-extension`)
    .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
    .set("x-admin-session", session)
    .send({ additionalDays: 5, reason: "verification window" })
    .expect(200);
  await request(env.app)
    .post(`/api/v1/admin/merchants/${storeId}/access-overrides`)
    .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
    .set("x-admin-session", session)
    .send({ kind: "COMP_ACCESS", accessUntil: new Date(Date.now() + 86400_000).toISOString(), reason: "bridge for review" })
    .expect(201);
}, 120_000);

afterAll(async () => {
  await env.close();
});

describe("GET /api/v1/admin/access-review", () => {
  it("requires the platform key (no key → 401, same as every admin read)", async () => {
    await request(env.app).get(`/api/v1/admin/access-review?storeId=${storeId}`).expect(401);
  });

  it("validates its input: missing storeId → 400; unknown store → 404 (typed envelopes)", async () => {
    const missing = await request(env.app)
      .get("/api/v1/admin/access-review")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(400);
    expect(missing.body.errors[0].code).toBe("VALIDATION_FAILED");
    await request(env.app)
      .get("/api/v1/admin/access-review?storeId=00000000-0000-0000-0000-000000000000")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(404);
  });

  it("shows store identity, the provisioned owner as an OWNER member with the full permission set", async () => {
    const res = await request(env.app)
      .get(`/api/v1/admin/access-review?storeId=${storeId}`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    const review = res.body.data;
    expect(review.store).toMatchObject({ storeId, shopDomain: TEST_SHOP });
    expect(review.store.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(review.store.uninstalledAt).toBeNull();

    const owner = review.members.find((member: { email: string }) => member.email === ownerEmail);
    expect(owner).toBeDefined();
    expect(owner.roleCode).toBe("OWNER");
    expect(owner.status).toBe("ACTIVE");
    expect(owner.permissionCount).toBeGreaterThan(20); // full catalog ≈24
    expect(owner.lastLoginAt).not.toBeNull();
    expect(review.members.every((member: { permissionCount: number }) => member.permissionCount > 0)).toBe(true);
  });

  it("lists the live access override with provenance and the store-bound operator actions", async () => {
    const res = await request(env.app)
      .get(`/api/v1/admin/access-review?storeId=${storeId}`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    const review = res.body.data;

    const override = review.activeOverrides.find((row: { reason: string }) => row.reason === "bridge for review");
    expect(override).toMatchObject({ kind: "COMP_ACCESS", grantedBy: "ops-review" });

    const actions = review.recentActions.map((row: { action: string }) => row.action);
    expect(actions).toContain(PlatformAdminAction.ExtendTrial);
    expect(actions).toContain(PlatformAdminAction.GrantAccessOverride);
    // Sessions are GLOBAL writes — they belong to the sessions ledger, not here.
    expect(actions).not.toContain(PlatformAdminAction.OpenSession);
    for (const row of review.recentActions) {
      expect(row.operatorId).toBe("ops-review");
      expect(row.ip).not.toBeNull();
    }
  });
});

describe("GET /api/v1/admin/access-review/sessions", () => {
  it("serves the global operator-session ledger (write-authority grants), newest first", async () => {
    const res = await request(env.app)
      .get("/api/v1/admin/access-review/sessions")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    const rows = res.body.data;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const ours = rows.find((row: { operatorId: string }) => row.operatorId === "ops-review");
    expect(ours).toBeDefined();
    expect(ours.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    if (rows.length > 1) {
      expect(Date.parse(rows[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(rows[rows.length - 1].createdAt));
    }
  });
});
