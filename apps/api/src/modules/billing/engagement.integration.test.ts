import { and, eq } from "@profit/db";
import { engagementEvents, stores } from "@profit/db";
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
 * /api/v1/engagement (M5 growth telemetry): the client can record ONLY a
 * whitelist of view-kind events; server-side milestones stay server-owned.
 * Milestone dedupe answers 200 {recorded:false} — never an error, never a row.
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-eng", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "engagement-owner" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
});

afterAll(async () => {
  await env.close();
});

describe("POST /api/v1/engagement/events", () => {
  it("records a whitelisted view milestone once, then idempotently answers 200", async () => {
    const first = await request(env.app)
      .post("/api/v1/engagement/events")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "FIRST_AI_INSIGHT_VIEWED", metadata: { surface: "command-center" } })
      .expect(201);
    expect(first.body.data).toEqual({ recorded: true });

    const repeat = await request(env.app)
      .post("/api/v1/engagement/events")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "FIRST_AI_INSIGHT_VIEWED" })
      .expect(200);
    expect(repeat.body.data).toEqual({ recorded: false });

    const rows = await env.db
      .select()
      .from(engagementEvents)
      .where(
        and(eq(engagementEvents.storeId, storeId), eq(engagementEvents.kind, "FIRST_AI_INSIGHT_VIEWED")),
      );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as Record<string, unknown>)["surface"]).toBe("command-center");
  });

  it("repeatable kinds stay repeatable (UPGRADE_VIEWED)", async () => {
    await request(env.app)
      .post("/api/v1/engagement/events")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "UPGRADE_VIEWED" })
      .expect(201);
    const again = await request(env.app)
      .post("/api/v1/engagement/events")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "UPGRADE_VIEWED" })
      .expect(201);
    expect(again.body.data).toEqual({ recorded: true });
  });

  it("rejects server-owned milestone kinds and malformed payloads (400), 401 without auth", async () => {
    await request(env.app)
      .post("/api/v1/engagement/events")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "STORE_CONNECTED" })
      .expect(400);
    await request(env.app)
      .post("/api/v1/engagement/events")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "CHURN_NUDGE_SENT" })
      .expect(400);
    await request(env.app)
      .post("/api/v1/engagement/events")
      .set("authorization", `Bearer ${accessToken}`)
      .send({})
      .expect(400);
    await request(env.app)
      .post("/api/v1/engagement/events")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "UPGRADE_VIEWED", surprise: true })
      .expect(400);
    await request(env.app).post("/api/v1/engagement/events").send({ kind: "UPGRADE_VIEWED" }).expect(401);
  });
});
