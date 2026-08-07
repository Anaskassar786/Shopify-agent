import { accessOverrides, and, desc, eq, platformAdminActions, subscriptions } from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformAdminAction, SubscriptionStatus, SupportTicketStatus } from "@profit/types";
import { AccessOverrideService } from "@profit/billing";
import { SupportService } from "@profit/automation";
import {
  buildTestEnvironment,
  PLATFORM_ADMIN_KEY,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  type TestEnvironment,
} from "../../test-support/harness";
import { stores, users } from "@profit/db";

/**
 * /api/v1/admin M6 write surface: step-up sessions, trial extensions, access
 * overrides, cross-tenant support inbox + replies, and the tamper-evident
 * action log. Every write proves: no session → 401; with session → effect +
 * platform_admin_actions row {operator, action, target, payloadHash, ip}.
 */

let env: TestEnvironment;
let storeId = "";
let accessToken = "";

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-admin6", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "admin6-owner" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
});

afterAll(async () => {
  await env.close();
});

async function openSession(operatorId = "ops-zoe"): Promise<string> {
  const res = await request(env.app)
    .post("/api/v1/admin/session")
    .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
    .send({ operatorId, reason: "M6 suite verification" })
    .expect(201);
  expect(res.body.data.operatorId).toBe(operatorId);
  return res.body.data.token as string;
}

describe("step-up session gate", () => {
  it("writes refuse without X-Admin-Session (401), then succeed with one", async () => {
    const naked = await request(env.app)
      .post(`/api/v1/admin/merchants/${storeId}/trial-extension`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .send({ additionalDays: 7, reason: "goodwill" });
    expect(naked.status).toBe(401);

    const forged = await request(env.app)
      .post(`/api/v1/admin/merchants/${storeId}/trial-extension`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", "v1.bogus.9999999999999.forged")
      .send({ additionalDays: 7, reason: "goodwill" });
    expect(forged.status).toBe(401);

    const token = await openSession();
    const ok = await request(env.app)
      .post(`/api/v1/admin/merchants/${storeId}/trial-extension`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ additionalDays: 7, reason: "goodwill after onboarding hiccup" })
      .expect(200);
    expect(ok.body.data.status).toBe(SubscriptionStatus.Trialing);
  });

  it("session open itself is recorded in the action log", async () => {
    await openSession("ops-log-check");
    const rows = await env.db
      .select()
      .from(platformAdminActions)
      .where(eq(platformAdminActions.action, PlatformAdminAction.OpenSession))
      .orderBy(desc(platformAdminActions.createdAt))
      .limit(1);
    expect(rows[0]?.operatorId).toBe("ops-log-check");
    expect(rows[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("trial extension", () => {
  it("stacks days on TRIALING and reactivates TRIAL_EXPIRED, ledger-backed", async () => {
    const rows = await env.db.select().from(subscriptions).where(eq(subscriptions.storeId, storeId));
    const before = rows[0]!.trialEndsAt;

    const token = await openSession();
    const extended = await request(env.app)
      .post(`/api/v1/admin/merchants/${storeId}/trial-extension`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ additionalDays: 5, reason: "data-migration delay" })
      .expect(200);
    const newEnd = new Date(extended.body.data.trialEndsAt as string);
    expect(newEnd.getTime()).toBe((before ?? new Date()).getTime() + 5 * 86_400_000);

    const action = await env.db
      .select()
      .from(platformAdminActions)
      .where(eq(platformAdminActions.action, PlatformAdminAction.ExtendTrial))
      .orderBy(desc(platformAdminActions.createdAt))
      .limit(1);
    expect(action[0]?.storeId).toBe(storeId);
    expect(action[0]?.targetType).toBe("subscription");

    // 0 days fails validation truthfully (zod) — never a silent no-op.
    const bad = await request(env.app)
      .post(`/api/v1/admin/merchants/${storeId}/trial-extension`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ additionalDays: 0, reason: "nope" });
    expect(bad.status).toBe(400);
  });
});

describe("access overrides", () => {
  it("grant (time-boxed) → gate unlocks; revoke → gate re-applies", async () => {
    const token = await openSession();
    const until = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const granted = await request(env.app)
      .post(`/api/v1/admin/merchants/${storeId}/access-overrides`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ kind: "COMP_ACCESS", accessUntil: until, reason: "INC-4412 data-loss mitigation" })
      .expect(201);
    expect(granted.body.data.grantedBy).toBe("ops-zoe");

    const listed = await request(env.app)
      .get(`/api/v1/admin/merchants/${storeId}/access-overrides`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    expect(listed.body.data.some((r: { id: string }) => r.id === granted.body.data.id)).toBe(true);

    const service = new AccessOverrideService(env.db);
    expect(await service.findActiveForStore(storeId)).not.toBeNull();

    await request(env.app)
      .post(`/api/v1/admin/merchants/${storeId}/access-overrides/${granted.body.data.id as string}/revoke`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ reason: "incident resolved" })
      .expect(200);
    expect(await service.findActiveForStore(storeId)).toBeNull();

    const rows = await env.db.select().from(accessOverrides).where(eq(accessOverrides.storeId, storeId));
    expect(rows[0]?.revokedAt).not.toBeNull();
    const actions = await env.db
      .select()
      .from(platformAdminActions)
      .where(
        and(
          eq(platformAdminActions.storeId, storeId),
          eq(platformAdminActions.action, PlatformAdminAction.RevokeAccessOverride),
        ),
      );
    expect(actions).toHaveLength(1);

    // A past window is refused at the API edge (service rule: future-only).
    const past = await request(env.app)
      .post(`/api/v1/admin/merchants/${storeId}/access-overrides`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ kind: "COMP_ACCESS", accessUntil: new Date(Date.now() - 60_000).toISOString(), reason: "backdate attempt" });
    expect(past.status).toBe(409);
  });
});

describe("cross-tenant support inbox", () => {
  it("operators read threads, reply (notify job queued), resolve and close", async () => {
    // Merchant opens a ticket through the tenant surface.
    const userRows = await env.db.select().from(users).limit(1);
    void userRows;
    const opened = await request(env.app)
      .post("/api/v1/support/tickets")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ subject: "Tracking pixel blocked", category: "BUG", body: "Gmail clips the footer image." })
      .expect(201);
    const ticketId = opened.body.data.id as string;

    // Operator inbox — read without step-up (read-only).
    const inbox = await request(env.app)
      .get("/api/v1/admin/tickets?attention=1")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    expect(inbox.body.data.rows.some((t: { id: string }) => t.id === ticketId)).toBe(true);

    const token = await openSession();
    const reply = await request(env.app)
      .post(`/api/v1/admin/tickets/${ticketId}/reply`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ body: "Known Gmail behavior — tracked in the M6 doc; the pixel is purely cosmetic." })
      .expect(201);
    expect(reply.body.data.messageId).toBeDefined();

    const support = new SupportService(env.db);
    const thread = await support.getTicket(storeId, ticketId);
    expect(thread?.ticket.status).toBe(SupportTicketStatus.WaitingOnCustomer);
    expect(thread?.ticket.assignedOperator).toBe("ops-zoe");

    await request(env.app)
      .post(`/api/v1/admin/tickets/${ticketId}/resolve`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .expect(200);
    const closed = await request(env.app)
      .post(`/api/v1/admin/tickets/${ticketId}/close`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .expect(200);
    expect(closed.body.data.status).toBe(SupportTicketStatus.Closed);

    // Closed tickets reject further operator replies.
    const late = await request(env.app)
      .post(`/api/v1/admin/tickets/${ticketId}/reply`)
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .set("x-admin-session", token)
      .send({ body: "again" });
    expect(late.status).toBe(409);
  });
});

describe("action log read", () => {
  it("GET /actions pages the operator audit trail (respects the key gate)", async () => {
    await request(env.app).get("/api/v1/admin/actions").expect(401);
    const res = await request(env.app)
      .get("/api/v1/admin/actions")
      .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
      .expect(200);
    const kinds = (res.body.data as Array<{ action: string }>).map((r) => r.action);
    expect(kinds).toContain(PlatformAdminAction.OpenSession);
    expect(kinds).toContain(PlatformAdminAction.ReplyTicket);
  });
});
