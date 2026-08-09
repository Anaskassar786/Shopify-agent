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
 * Audit log read API (P4 audit timeline). The trail already contains real
 * entries from the install + login flows, so this suite reads production-
 * produced data — no fixture rows — and proves filters, pagination, RBAC.
 */

let env: TestEnvironment;
let accessToken = "";

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app)
    .get(`/shopify/install?shop=${TEST_SHOP}`)
    .expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-audit", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "audit-owner" });
  const login = await request(env.app)
    .post("/api/v1/auth/session")
    .send({ sessionToken })
    .expect(200);
  accessToken = login.body.data.accessToken as string;
});

afterAll(async () => {
  await env.close();
});

describe("GET /api/v1/audit-logs", () => {
  it("lists the trail produced by install + login (real data, newest first)", async () => {
    const res = await request(env.app)
      .get("/api/v1/audit-logs")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const actions = (res.body.data as Array<{ action: string }>).map((r) => r.action);
    expect(actions.some((a) => a.startsWith("authentication."))).toBe(true);
    expect(actions.some((a) => a.startsWith("shopify."))).toBe(true);
    const times = (res.body.data as Array<{ createdAt: string }>).map((r) => new Date(r.createdAt).getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it("filters by action prefix and result", async () => {
    const authOnly = await request(env.app)
      .get("/api/v1/audit-logs?action=authentication")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(
      (authOnly.body.data as Array<{ action: string }>).every((r) =>
        r.action.startsWith("authentication"),
      ),
    ).toBe(true);

    const failures = await request(env.app)
      .get("/api/v1/audit-logs?result=FAILURE")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(
      (failures.body.data as Array<{ result: string }>).every((r) => r.result === "FAILURE"),
    ).toBe(true);
  });

  it("rejects a bogus result filter with the validation envelope", async () => {
    const res = await request(env.app)
      .get("/api/v1/audit-logs?result=MAYBE")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(400);
    expect(res.body.errors[0].code).toBe("VALIDATION_FAILED");
  });

  it("paginates deterministically", async () => {
    const page1 = await request(env.app)
      .get("/api/v1/audit-logs?page=1&limit=2")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.pagination.totalItems).toBeGreaterThanOrEqual(2);
    const page2 = await request(env.app)
      .get("/api/v1/audit-logs?page=2&limit=2")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const ids1 = new Set((page1.body.data as Array<{ id: string }>).map((r) => r.id));
    for (const row of page2.body.data as Array<{ id: string }>) {
      expect(ids1.has(row.id)).toBe(false);
    }
  });
});

describe("RBAC", () => {
  it("VIEWER is denied (audit:read absent from the matrix)", async () => {
    stubShopifyHttp({ accountOwner: false });
    const viewerSession = await signShopifySessionToken({ shopifyUserId: "audit-viewer" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken: viewerSession })
      .expect(200);
    const viewerToken = login.body.data.accessToken as string;
    const res = await request(env.app)
      .get("/api/v1/audit-logs")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);
    expect(res.body.errors[0].message).toContain("audit:read");
    stubShopifyHttp();
  });
});
