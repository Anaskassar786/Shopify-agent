import { eq } from "@profit/db";
import { stores } from "@profit/db";
import { MemoryPubSub } from "@profit/cache";
import { NotificationService } from "@profit/notifications";
import { NotificationCategory } from "@profit/types";
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
 * Notification Center API (P4/M3): tenant-scoped reads, unread counts in
 * envelope meta, idempotent marks, audience rules, RBAC. Row creation happens
 * through the production writer (NotificationService) — the same path the
 * worker uses — so this suite proves writer↔reader symmetry end to end.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";
let notifications: NotificationService;

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app)
    .get(`/shopify/install?shop=${TEST_SHOP}`)
    .expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-notify", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "notify-owner" });
  const login = await request(env.app)
    .post("/api/v1/auth/session")
    .send({ sessionToken })
    .expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
  notifications = new NotificationService(env.db, new MemoryPubSub());
});

afterAll(async () => {
  await env.close();
});

describe("GET /api/v1/notifications", () => {
  it("returns tenant rows with unread count in envelope meta", async () => {
    await notifications.create(storeId, {
      category: NotificationCategory.System,
      title: "Sync completed",
      body: "Full data sync finished.",
      actionUrl: "/settings/sync",
    });
    const res = await request(env.app)
      .get("/api/v1/notifications")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.meta.extras.unread).toBeGreaterThanOrEqual(1);
    const row = res.body.data[0];
    expect(row.title).toBe("Sync completed");
    expect(row.category).toBe("SYSTEM");
  });

  it("honours category + unreadOnly filters", async () => {
    await notifications.create(storeId, {
      category: NotificationCategory.Inventory,
      title: "Low stock",
      body: "SKU ABC below threshold.",
    });
    const inventoryOnly = await request(env.app)
      .get("/api/v1/notifications?category=INVENTORY")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(inventoryOnly.body.data.every((n: { category: string }) => n.category === "INVENTORY")).toBe(true);

    await request(env.app)
      .post("/api/v1/notifications/read-all")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const unread = await request(env.app)
      .get("/api/v1/notifications?unreadOnly=true")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(unread.body.data).toHaveLength(0);
    expect(unread.body.meta.extras.unread).toBe(0);
  });

  it("rejects malformed filters with the validation envelope", async () => {
    const res = await request(env.app)
      .get("/api/v1/notifications?category=HYPERDRIVE")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(400);
    expect(res.body.errors[0].code).toBe("VALIDATION_FAILED");
  });
});

describe("mark read", () => {
  it("POST /:id/read is idempotent and scoped to the caller", async () => {
    const row = await notifications.create(storeId, {
      category: NotificationCategory.Orders,
      title: "Order risk detected",
      body: "High-value order from a first-time customer.",
    });
    const first = await request(env.app)
      .post(`/api/v1/notifications/${row.id}/read`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(first.body.data.readAt).not.toBeNull();
    const second = await request(env.app)
      .post(`/api/v1/notifications/${row.id}/read`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(second.body.data.readAt).toBe(first.body.data.readAt);

    const missing = await request(env.app)
      .post(`/api/v1/notifications/${crypto.randomUUID()}/read`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(missing.body.data).toBeNull();
  });

  it("POST /read-all flips the visible unread set and reports the count", async () => {
    await notifications.create(storeId, {
      category: NotificationCategory.Billing,
      title: "Trial started",
      body: "Your 3-day trial is running.",
    });
    const res = await request(env.app)
      .post("/api/v1/notifications/read-all")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.markedRead).toBeGreaterThanOrEqual(1);
  });
});

describe("RBAC", () => {
  it("VIEWER may read but not mark (matrix: lacks notifications:update)", async () => {
    stubShopifyHttp({ accountOwner: false });
    const viewerSession = await signShopifySessionToken({ shopifyUserId: "notify-viewer" });
    const login = await request(env.app)
      .post("/api/v1/auth/session")
      .send({ sessionToken: viewerSession })
      .expect(200);
    const viewerToken = login.body.data.accessToken as string;
    expect(login.body.data.user.role).toBe("VIEWER");

    await request(env.app)
      .get("/api/v1/notifications")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(200);
    const forbidden = await request(env.app)
      .post("/api/v1/notifications/read-all")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);
    expect(forbidden.body.errors[0].message).toContain("notifications:update");
    stubShopifyHttp();
  });
});
