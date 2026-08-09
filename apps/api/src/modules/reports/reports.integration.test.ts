import type { IncomingMessage } from "node:http";
import { eq } from "@profit/db";
import { dailyMetrics, revenueMetrics, stores } from "@profit/db";
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
 * Reports + forecasts API (M8, ADR 33/34/35): manual generation over HTTP,
 * the PDF vault, typed delivery outcomes, settings whitelist round-trip and
 * RBAC. Harness sender is null ⇒ delivery reports "email-unavailable".
 */

let env: TestEnvironment;
let accessToken = "";
let storeId = "";

/** supertest .parse() contract: the runtime value is the raw Node stream. */
function binaryParser(res: unknown, callback: (err: Error | null, body: unknown) => void): void {
  const stream = res as IncomingMessage;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => callback(null, Buffer.concat(chunks)));
}

function iso(daysBefore: number): string {
  return new Date(Date.now() - daysBefore * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-reports", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "reports-owner" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;

  await env.db.insert(revenueMetrics).values(
    Array.from({ length: 45 }, (_, i) => ({
      storeId,
      metricDate: iso(45 - i),
      netSalesCents: 10_000,
      grossSalesCents: 12_000,
      discountsCents: 500,
      refundsCents: 0,
    })),
  );
  await env.db.insert(dailyMetrics).values(
    Array.from({ length: 45 }, (_, i) => ({
      storeId,
      metricDate: iso(45 - i),
      ordersCount: 4,
      cancelledOrders: 0,
      itemsSold: 8,
      newCustomers: 1,
      returningCustomers: 1,
      aovCents: 2_500,
    })),
  );
}, 120_000);

afterAll(async () => {
  await env.close();
});

describe("POST /api/v1/reports/generate + vault reads", () => {
  let reportId = "";

  it("generates the closed weekly period with reconciled numbers", async () => {
    const created = await request(env.app)
      .post("/api/v1/reports/generate")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "WEEKLY" })
      .expect(201);
    expect(created.body.data.status).toBe("READY");
    expect(created.body.data.periodLabel).toContain("–");
    reportId = created.body.data.reportId as string;

    const list = await request(env.app)
      .get("/api/v1/reports?kind=WEEKLY")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(reportId);
    expect(list.body.data[0].pdfSizeBytes).toBeGreaterThan(500);

    const detail = await request(env.app)
      .get(`/api/v1/reports/${reportId}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const kpis = detail.body.data.sections.kpis as { label: string; display: string }[];
    expect(kpis.find((kpi) => kpi.label === "Net sales")!.display).toBe("$700.00");
    expect(detail.body.data.sections.forecast.method).toBe("revenue.weekly-seasonality.v1");
    expect(detail.body.data.executiveSummary).toContain("Demo Store");
  });

  it("streams the stored PDF bytes with a deterministic filename", async () => {
    const res = await request(env.app)
      .get(`/api/v1/reports/${reportId}/pdf`)
      .set("authorization", `Bearer ${accessToken}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("demo-store-weekly-");
    const bytes = res.body as Buffer;
    expect(bytes.slice(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Number(res.headers["content-length"])).toBe(bytes.length);
  });

  it("rejects invalid kinds and unknown ids cleanly", async () => {
    await request(env.app)
      .post("/api/v1/reports/generate")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "HOURLY" })
      .expect(400);
    await request(env.app)
      .get(`/api/v1/reports/${crypto.randomUUID()}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(404);
  });

  it("manual regeneration of the same closed period converges on one row", async () => {
    const again = await request(env.app)
      .post("/api/v1/reports/generate")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ kind: "WEEKLY" })
      .expect(201);
    expect(again.body.data.reportId).toBe(reportId);
    const list = await request(env.app)
      .get("/api/v1/reports?kind=WEEKLY")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
  });
});

describe("POST /api/v1/reports/:id/email — typed delivery outcomes", () => {
  it("reports email-unavailable honestly when SMTP is not configured", async () => {
    const list = await request(env.app)
      .get("/api/v1/reports")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const res = await request(env.app)
      .post(`/api/v1/reports/${list.body.data[0].id}/email`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({ recipientEmail: "merchant@example.com" })
      .expect(200);
    expect(res.body.data).toEqual({ sent: false, reason: "email-unavailable" });
  });

  it("validates the recipient when supplied", async () => {
    const list = await request(env.app)
      .get("/api/v1/reports")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    await request(env.app)
      .post(`/api/v1/reports/${list.body.data[0].id}/email`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({ recipientEmail: "not-an-email" })
      .expect(400);
  });

  it("falls back to the store contact email (install fixture has one) — same typed outcome", async () => {
    const list = await request(env.app)
      .get("/api/v1/reports")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const res = await request(env.app)
      .post(`/api/v1/reports/${list.body.data[0].id}/email`)
      .set("authorization", `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    expect(res.body.data.reason).toBe("email-unavailable");
  });
});

describe("report preferences through the settings whitelist (ADR 34)", () => {
  it("PATCH round-trips the schedule with nested-merge semantics", async () => {
    const patched = await request(env.app)
      .patch("/api/v1/store/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({
        reportPreferences: {
          kinds: { DAILY: true, WEEKLY: false },
          emailDelivery: true,
          recipientEmail: "owner@example.com",
        },
      })
      .expect(200);
    const prefs = patched.body.data.reportPreferences;
    expect(prefs.kinds.DAILY).toBe(true);
    expect(prefs.kinds.WEEKLY).toBe(false);
    expect(prefs.emailDelivery).toBe(true);
    expect(prefs.recipientEmail).toBe("owner@example.com");

    // A partial follow-up merge must not drop siblings.
    const follow = await request(env.app)
      .patch("/api/v1/store/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ reportPreferences: { kinds: { QUARTERLY: true } } })
      .expect(200);
    expect(follow.body.data.reportPreferences.kinds.DAILY).toBe(true);
    expect(follow.body.data.reportPreferences.kinds.QUARTERLY).toBe(true);
  });

  it("rejects malformed preference payloads", async () => {
    await request(env.app)
      .patch("/api/v1/store/settings")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ reportPreferences: { recipientEmail: "nope" } })
      .expect(400);
  });
});

describe("GET /api/v1/analytics/forecasts (ADR 33)", () => {
  it("returns the method-stamped read model", async () => {
    const res = await request(env.app)
      .get("/api/v1/analytics/forecasts?horizonDays=14")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.revenueMethod).toBe("revenue.weekly-seasonality.v1");
    expect(res.body.data.demandMethod).toBe("demand.velocity.v1");
    expect(res.body.data.horizonDays).toBe(14);
    expect(res.body.data.revenue.totalExpectedCents).toBe(140_000); // 14 × $100.00
    expect(res.body.data.churnRisks).toBeInstanceOf(Array);
  });

  it("validates the horizon", async () => {
    await request(env.app)
      .get("/api/v1/analytics/forecasts?horizonDays=99")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(400);
  });
});

describe("RBAC", () => {
  it("VIEWER cannot list, generate, download or email reports", async () => {
    stubShopifyHttp({ accountOwner: false });
    const viewerSession = await signShopifySessionToken({ shopifyUserId: "reports-viewer" });
    const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken: viewerSession }).expect(200);
    const viewerToken = login.body.data.accessToken as string;
    const owner = await request(env.app).get("/api/v1/reports").set("authorization", `Bearer ${accessToken}`).expect(200);
    const reportId = owner.body.data[0].id as string;

    await request(env.app).get("/api/v1/reports").set("authorization", `Bearer ${viewerToken}`).expect(403);
    await request(env.app)
      .post("/api/v1/reports/generate")
      .set("authorization", `Bearer ${viewerToken}`)
      .send({ kind: "WEEKLY" })
      .expect(403);
    await request(env.app)
      .get(`/api/v1/reports/${reportId}/pdf`)
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(403);
    await request(env.app)
      .post(`/api/v1/reports/${reportId}/email`)
      .set("authorization", `Bearer ${viewerToken}`)
      .send({ recipientEmail: "x@y.z" })
      .expect(403);
  });
});
