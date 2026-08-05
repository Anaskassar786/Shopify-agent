import { eq } from "@profit/db";
import { refreshTokens, sessions, stores, userStoreMemberships, users } from "@profit/db";
import { UserRole } from "@profit/types";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "../../lib/errors";
import { requirePermission } from "../../middleware/auth.middleware";
import type { AppAuthClaims } from "../auth/jwt.service";
import {
  buildTestEnvironment,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../../test-support/harness";

/**
 * First-party auth (P2): session-token login → JIT provisioning → JWT + refresh
 * rotation with reuse detection. Runs against the real app and real Postgres,
 * with an installed demo store prepared via the real OAuth callback.
 */

let env: TestEnvironment;

async function installDemoStore(): Promise<void> {
  const res = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(res.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-auth", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  await installDemoStore();
});

afterAll(async () => {
  await env.close();
});

describe("POST /api/v1/auth/session", () => {
  it("provisions the store owner on first embedded login and issues a token pair", async () => {
    const sessionToken = await signShopifySessionToken({ shopifyUserId: "shopify-user-owner" });
    const res = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.role).toBe(UserRole.Owner);
    expect(res.body.data.user.fullName).toBe("Ada Merchant");
    expect(res.body.data.store.shopDomain).toBe(TEST_SHOP);

    const row = await env.db
      .select()
      .from(users)
      .where(eq(users.shopifyUserId, "shopify-user-owner"));
    expect(row).toHaveLength(1);

    const membershipRows = await env.db.select().from(userStoreMemberships);
    expect(membershipRows).toHaveLength(1);
  });

  it("grants VIEWER (secure default) to a second, non-owner user", async () => {
    stubShopifyHttp({ accountOwner: false });
    const token2 = await signShopifySessionToken({ shopifyUserId: "shopify-user-staff" });
    const res = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken: token2 })
      .expect(200);
    expect(res.body.data.user.role).toBe(UserRole.Viewer);
    stubShopifyHttp({ accountOwner: true });
  });

  it("rejects a forged session token (wrong signature)", async () => {
    const res = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken: "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2RlbW8tc3RvcmUubXlzaG9waWZ5LmNvbS9hZG1pbiIsImRlc3QiOiJodHRwczovL2RlbW8tc3RvcmUubXlzaG9waWZ5LmNvbSIsInN1YiI6InQiLCJzaWQiOiJzIiwiZXhwIjo5OTk5OTk5OTk5LCJpYXQiOjF9.forged" })
      .expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects login for an uninstalled shop", async () => {
    const other = await signShopifySessionToken({
      shopifyUserId: "ghost",
      shop: "never-installed.myshopify.com",
    });
    await request(env.app).post("/api/v1/auth/session").send({ sessionToken: other }).expect(401);
  });
});

describe("GET /api/v1/auth/me", () => {
  it("returns fresh profile + permissions for a valid token", async () => {
    const sessionToken = await signShopifySessionToken({ shopifyUserId: "shopify-user-owner" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken })
      .expect(200);
    const me = await request(env.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .expect(200);

    expect(me.body.data.user.role).toBe(UserRole.Owner);
    expect(me.body.data.permissions).toContain("recommendations:approve");
    expect(me.body.data.permissions).toContain("billing:manage");
  });

  it("rejects missing and tampered access tokens (401)", async () => {
    await request(env.app).get("/api/v1/auth/me").expect(401);
    await request(env.app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer garbage.token.value")
      .expect(401);
  });
});

describe("POST /api/v1/auth/refresh (rotation + reuse detection)", () => {
  it("rotates: new pair works, old refresh is burned", async () => {
    const sessionToken = await signShopifySessionToken({ shopifyUserId: "shopify-user-owner" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken })
      .expect(200);

    const rotated = await request(env.app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(200);
    expect(rotated.body.data.accessToken).toBeTruthy();
    expect(rotated.body.data.refreshToken).not.toBe(login.body.data.refreshToken);

    await request(env.app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(401);
  });

  it("reuse detection: presenting a burned token revokes the entire session chain", async () => {
    const sessionToken = await signShopifySessionToken({ shopifyUserId: "shopify-user-owner" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken })
      .expect(200);

    await request(env.app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(200);

    // Attacker replays the original token → chain revocation.
    await request(env.app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(401);

    const row = await env.db
      .select()
      .from(refreshTokens)
      .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
      .where(eq(sessions.userId, login.body.data.user.id))
      .orderBy(sessions.createdAt);
    const latestSessionRows = row.filter((r) => r.sessions.revokedAt !== null);
    expect(latestSessionRows.length).toBeGreaterThan(0);
  });
});

describe("requirePermission guard (RBAC, P2)", () => {
  function runGuard(permissions: string[], required: string): unknown {
    let passedThrough = false;
    let captured: unknown;
    const guard = requirePermission(required);
    const req = {
      appAuth: { permissions } as Partial<AppAuthClaims> as AppAuthClaims,
    } as Request;
    const next: NextFunction = (err?: unknown) => {
      if (err === undefined) passedThrough = true;
      else captured = err;
    };
    guard(req, {} as Response, next);
    return { passedThrough, captured };
  }

  it("allows when permission is present", () => {
    const outcome = runGuard(["store:read"], "store:read") as { passedThrough: boolean };
    expect(outcome.passedThrough).toBe(true);
  });

  it("denies with 403 ForbiddenError when permission is missing", () => {
    const outcome = runGuard(["store:read"], "billing:manage") as { captured: unknown };
    expect(outcome.captured).toBeInstanceOf(ForbiddenError);
    expect((outcome.captured as ForbiddenError).httpStatus).toBe(403);
  });
});
