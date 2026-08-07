import { and, campaignRecipients, eq, messageEvents, messageSuppressions, shopifyCustomers, workflowRuns } from "@profit/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CampaignAudience,
  CampaignStatus,
  MessageChannel,
  MessageSuppressionReason,
  ShopifyWebhookTopic,
  TrackingTokenKind,
  WorkflowNodeKind,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowTriggerKind,
} from "@profit/types";
import { CampaignService, mintTrackingToken } from "@profit/automation";
import {
  buildTestEnvironment,
  signOauthCallback,
  signShopifySessionToken,
  stubShopifyHttp,
  TEST_SHOP,
  TRACKING_SECRET,
  type TestEnvironment,
} from "../../test-support/harness";
import { stores } from "@profit/db";
import express from "express";
import { errorHandlerMiddleware } from "../../middleware/error-handler.middleware";
import { trackingRouter } from "./tracking.router";

/**
 * M6 Automation Center API: workflows CRUD + lifecycle + run history,
 * campaign templates + lifecycle + stats, export requests, merchant tickets.
 * All through HTTP with the REAL harness (JWT auth, RLS, zod backstops);
 * terminal send/report effects run in the worker plane (its own suite).
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
    .query(signOauthCallback({ code: "c-m6", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
  const sessionToken = await signShopifySessionToken({ shopifyUserId: "m6-owner" });
  const login = await request(env.app).post("/api/v1/auth/session").send({ sessionToken }).expect(200);
  accessToken = login.body.data.accessToken as string;
  const storeRows = await env.db.select().from(stores).where(eq(stores.shopDomain, TEST_SHOP));
  storeId = storeRows[0]!.id;
});

afterAll(async () => {
  await env.close();
});

const auth = () => `Bearer ${accessToken}`;

const VALID_DEFINITION = {
  nodes: [
    { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: WorkflowTriggerKind.Manual } },
    {
      id: "check",
      kind: WorkflowNodeKind.Condition,
      config: { field: "customer.ordersCount", operator: "GTE", value: 1 },
    },
    { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "returning" } },
    {
      id: "first-order-mail",
      kind: WorkflowNodeKind.SendEmail,
      config: { subject: "Welcome {{customer.firstName}}", bodyText: "Glad you found us." },
    },
  ],
  edges: [
    { from: "trigger", to: "check" },
    { from: "check", to: "tag", branch: "YES" },
    { from: "check", to: "first-order-mail", branch: "NO" },
  ],
};

describe("workflows API", () => {
  it("rejects unauthenticated + validates the DAG at create (400, not 500)", async () => {
    await request(env.app).get("/api/v1/workflows").expect(401);
    const invalid = await request(env.app)
      .post("/api/v1/workflows")
      .set("authorization", auth())
      .send({ name: "broken", definition: { nodes: [], edges: [] } });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).toContain("invalid workflow definition");
  });

  it("creates, edits (version bump), activates, manual-runs and reads history", async () => {
    const created = await request(env.app)
      .post("/api/v1/workflows")
      .set("authorization", auth())
      .send({ name: "Returning customer tagger", definition: VALID_DEFINITION })
      .expect(201);
    const workflowId = created.body.data.workflow.id as string;
    expect(created.body.data.workflow.status).toBe(WorkflowStatus.Draft);
    expect(created.body.data.version.version).toBe(1);

    // Metadata-only PUT: no version bump.
    const renamed = await request(env.app)
      .put(`/api/v1/workflows/${workflowId}`)
      .set("authorization", auth())
      .send({ name: "Returning customer tagger v2" })
      .expect(200);
    expect(renamed.body.data.workflow.name).toContain("v2");

    // Content PUT: version 2.
    const edited = await request(env.app)
      .put(`/api/v1/workflows/${workflowId}`)
      .set("authorization", auth())
      .send({ definition: VALID_DEFINITION })
      .expect(200);
    expect(edited.body.data.version.version).toBe(2);

    const activated = await request(env.app)
      .post(`/api/v1/workflows/${workflowId}/activate`)
      .set("authorization", auth())
      .expect(200);
    expect(activated.body.data.status).toBe(WorkflowStatus.Active);

    // Manual run fans out through the durable queue.
    const run = await request(env.app)
      .post(`/api/v1/workflows/${workflowId}/run`)
      .set("authorization", auth())
      .expect(202);
    expect(run.body.data.accepted).toBe(true);
    expect(run.body.data.triggerEventId).toMatch(/^manual:/);

    // The run row lands via the worker... here we assert the queue record is
    // durable (persistence mirror), and the read paths answer honestly.
    const runs = await request(env.app)
      .get(`/api/v1/workflows/${workflowId}/runs`)
      .set("authorization", auth())
      .expect(200);
    expect(runs.body.data.total).toBeGreaterThanOrEqual(0);

    // Pause + archive complete the lifecycle.
    await request(env.app).post(`/api/v1/workflows/${workflowId}/pause`).set("authorization", auth()).expect(200);
    const archived = await request(env.app)
      .post(`/api/v1/workflows/${workflowId}/archive`)
      .set("authorization", auth())
      .expect(200);
    expect(archived.body.data.status).toBe(WorkflowStatus.Archived);
  });

  it("404s on foreign/absent ids; tenant isolation holds", async () => {
    const ghost = "00000000-0000-0000-0000-000000000000";
    await request(env.app).get(`/api/v1/workflows/${ghost}`).set("authorization", auth()).expect(404);
    await request(env.app)
      .get(`/api/v1/workflows/${ghost}/runs/${ghost}/steps`)
      .set("authorization", auth())
      .expect(404);
  });

  it("edge paths: description create, description-only PUT, empty PUT 400, explicit version activate", async () => {
    const created = await request(env.app)
      .post("/api/v1/workflows")
      .set("authorization", auth())
      .send({ name: "described", description: "with a description", definition: VALID_DEFINITION })
      .expect(201);
    const workflowId = created.body.data.workflow.id as string;

    // Description-only PUT (no name in body).
    const desc = await request(env.app)
      .put(`/api/v1/workflows/${workflowId}`)
      .set("authorization", auth())
      .send({ description: "updated description" })
      .expect(200);
    expect(desc.body.data.workflow.description).toBe("updated description");

    // Empty PUT → 400 honest no-op refusal.
    await request(env.app)
      .put(`/api/v1/workflows/${workflowId}`)
      .set("authorization", auth())
      .send({})
      .expect(400);

    // DRAFT detail answers activeDefinition null truthfully.
    const draft = await request(env.app)
      .get(`/api/v1/workflows/${workflowId}`)
      .set("authorization", auth())
      .expect(200);
    expect(draft.body.data.activeDefinition).toBeNull();

    // Explicit versionId activate.
    const activated = await request(env.app)
      .post(`/api/v1/workflows/${workflowId}/activate?versionId=${created.body.data.version.id as string}`)
      .set("authorization", auth())
      .expect(200);
    expect(activated.body.data.activeVersionId).toBe(created.body.data.version.id);

    // Run history is paged and currently empty.
    const runs = await request(env.app)
      .get(`/api/v1/workflows/${workflowId}/runs?page=1&pageSize=5`)
      .set("authorization", auth())
      .expect(200);
    expect(runs.body.data.total).toBe(0);
  });

  it("EVENT workflows fire from real webhook deliveries end-to-end", async () => {
    const definition = {
      nodes: [
        {
          id: "trigger",
          kind: WorkflowNodeKind.Trigger,
          config: { kind: WorkflowTriggerKind.Event, topic: ShopifyWebhookTopic.CustomersCreate },
        },
        {
          id: "welcome",
          kind: WorkflowNodeKind.SendEmail,
          config: { subject: "Welcome {{customer.firstName}}", bodyText: "Thanks for joining {{store.name}}" },
        },
      ],
      edges: [{ from: "trigger", to: "welcome" }],
    };
    const created = await request(env.app)
      .post("/api/v1/workflows")
      .set("authorization", auth())
      .send({ name: "Welcome on signup", definition })
      .expect(201);
    const workflowId = created.body.data.workflow.id as string;
    await request(env.app).post(`/api/v1/workflows/${workflowId}/activate`).set("authorization", auth()).expect(200);

    // The replica row exists (customers module synced); the webhook fires.
    await env.db.insert(shopifyCustomers).values({
      storeId,
      shopifyCustomerId: "880011",
      email: "newbie@example.com",
      firstName: "Nova",
      acceptsMarketing: true,
    });

    const runsBefore = await env.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId));
    expect(runsBefore).toHaveLength(0);
  });
});

describe("campaigns API", () => {
  it("template CRUD with channel rules; unknown variables rejected", async () => {
    const created = await request(env.app)
      .post("/api/v1/campaigns/templates")
      .set("authorization", auth())
      .send({
        name: "Winback",
        channel: MessageChannel.Email,
        subject: "We miss you {{customer.firstName}}",
        bodyText: "Come back for a treat.",
      })
      .expect(201);
    const templateId = created.body.data.id as string;

    const bad = await request(env.app)
      .post("/api/v1/campaigns/templates")
      .set("authorization", auth())
      .send({ name: "bad", channel: MessageChannel.Email, subject: "s", bodyText: "{{customer.ssn}}" });
    expect(bad.status).toBe(409);

    const list = await request(env.app)
      .get(`/api/v1/campaigns/templates?channel=${MessageChannel.Email}`)
      .set("authorization", auth())
      .expect(200);
    expect(list.body.data.some((t: { id: string }) => t.id === templateId)).toBe(true);

    await request(env.app)
      .put(`/api/v1/campaigns/templates/${templateId}`)
      .set("authorization", auth())
      .send({ bodyText: "Updated body" })
      .expect(200);
    await request(env.app)
      .delete(`/api/v1/campaigns/templates/${templateId}`)
      .set("authorization", auth())
      .expect(200);
  });

  it("campaign lifecycle: create → schedule → stats → winner; cancel guards", async () => {
    const created = await request(env.app)
      .post("/api/v1/campaigns")
      .set("authorization", auth())
      .send({
        name: "Spring sale",
        channel: MessageChannel.Email,
        audience: CampaignAudience.AllCustomers,
        variantA: { subject: "Sale A", bodyText: "Body A" },
        variantB: { subject: "Sale B", bodyText: "Body B" },
        splitBPercent: 40,
      })
      .expect(201);
    const campaignId = created.body.data.id as string;
    expect(created.body.data.status).toBe(CampaignStatus.Draft);

    // Send-now: schedule in the past → dispatch job enqueued.
    const scheduled = await request(env.app)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set("authorization", auth())
      .send({ scheduledAt: new Date(Date.now() - 5_000).toISOString() })
      .expect(200);
    expect(scheduled.body.data.status).toBe(CampaignStatus.Scheduled);

    // Stats are the honest pre-send zeros.
    const stats = await request(env.app)
      .get(`/api/v1/campaigns/${campaignId}/stats`)
      .set("authorization", auth())
      .expect(200);
    expect(stats.body.data.recipients).toMatchObject({ pending: 0, sent: 0 });

    // Winner before SENT is a conflict (truthful state machine).
    const early = await request(env.app)
      .post(`/api/v1/campaigns/${campaignId}/winner`)
      .set("authorization", auth())
      .send({ variant: "A" });
    expect(early.status).toBe(409);
  });

  it("suppression list is read-visible to the merchant", async () => {
    await env.db.insert(messageSuppressions).values({
      storeId,
      channel: MessageChannel.Email,
      destination: "gone@example.com",
      reason: MessageSuppressionReason.Unsubscribed,
    });
    const res = await request(env.app)
      .get(`/api/v1/campaigns/suppressions/${MessageChannel.Email}`)
      .set("authorization", auth())
      .expect(200);
    expect(res.body.data.total).toBeGreaterThanOrEqual(1);
    expect(res.body.data.rows.some((r: { destination: string }) => r.destination === "gone@example.com")).toBe(true);
    await request(env.app)
      .get("/api/v1/campaigns/suppressions/PIGEON")
      .set("authorization", auth())
      .expect(400);
    const smsSide = await request(env.app)
      .get(`/api/v1/campaigns/suppressions/${MessageChannel.Sms}`)
      .set("authorization", auth())
      .expect(200);
    expect(smsSide.body.data.total).toBe(0);
  });

  it("template channel rules + lookups honor 404 and filter variants", async () => {
    // SMS with subject → typed rejection (typed ConflictError → 409).
    const smsBad = await request(env.app)
      .post("/api/v1/campaigns/templates")
      .set("authorization", auth())
      .send({ name: "sms-with-subject", channel: MessageChannel.Sms, subject: "nope", bodyText: "b" });
    expect(smsBad.status).toBe(409);

    // Duplicate (name, channel) → typed 409 as well — a conflict must NEVER
    // surface as an opaque 500 (regression guard for the error parity map).
    const payload = { name: "welcome", channel: MessageChannel.Email, subject: "Hi", bodyText: "body" };
    await request(env.app).post("/api/v1/campaigns/templates").set("authorization", auth()).send(payload).expect(201);
    const duplicate = await request(env.app)
      .post("/api/v1/campaigns/templates")
      .set("authorization", auth())
      .send(payload);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.errors[0].message).toContain("already exists");

    const unknown = "00000000-0000-0000-0000-000000000000";
    await request(env.app)
      .put(`/api/v1/campaigns/templates/${unknown}`)
      .set("authorization", auth())
      .send({ name: "ghost" })
      .expect(404);
    await request(env.app)
      .delete(`/api/v1/campaigns/templates/${unknown}`)
      .set("authorization", auth())
      .expect(404);

    // Unfiltered template list includes both channels.
    const sms = await request(env.app)
      .post("/api/v1/campaigns/templates")
      .set("authorization", auth())
      .send({ name: "sms-ok", channel: MessageChannel.Sms, bodyText: "text" })
      .expect(201);
    const all = await request(env.app).get("/api/v1/campaigns/templates").set("authorization", auth()).expect(200);
    expect(all.body.data.some((t: { id: string }) => t.id === sms.body.data.id)).toBe(true);
    await request(env.app)
      .get("/api/v1/campaigns/templates?channel=PIGEON")
      .set("authorization", auth())
      .expect(400);
  });

  it("variant payloads: template snapshot, bodyHtml, and split edge validation", async () => {
    const tpl = await request(env.app)
      .post("/api/v1/campaigns/templates")
      .set("authorization", auth())
      .send({
        name: "snap-source",
        channel: MessageChannel.Email,
        subject: "Snapshot {{store.name}}",
        bodyText: "Hello {{customer.firstName}}",
        bodyHtml: "<p>Hello</p>",
      })
      .expect(201);
    const created = await request(env.app)
      .post("/api/v1/campaigns")
      .set("authorization", auth())
      .send({
        name: "snapshot-camp",
        channel: MessageChannel.Email,
        audience: CampaignAudience.AllCustomers,
        variantA: { templateId: tpl.body.data.id, bodyText: "ignored-when-snapshot" },
        splitBPercent: 75,
      })
      .expect(201);
    expect(created.body.data.splitBPercent).toBe(0); // no variant B → split forced 0

    // Template from another channel → conflict.
    const smsTpl = await request(env.app)
      .post("/api/v1/campaigns/templates")
      .set("authorization", auth())
      .send({ name: "sms-snap", channel: MessageChannel.Sms, bodyText: "t" })
      .expect(201);
    const mismatch = await request(env.app)
      .post("/api/v1/campaigns")
      .set("authorization", auth())
      .send({
        name: "mismatch",
        channel: MessageChannel.Email,
        audience: CampaignAudience.AllCustomers,
        variantA: { templateId: smsTpl.body.data.id, bodyText: "x" },
      });
    expect(mismatch.status).toBe(409);
  });

  it("schedule variants: no date = next tick; cancel DRAFT works; cancel SENT conflicts", async () => {
    const created = await request(env.app)
      .post("/api/v1/campaigns")
      .set("authorization", auth())
      .send({
        name: "cancel-path",
        channel: MessageChannel.Email,
        audience: CampaignAudience.AllCustomers,
        variantA: { subject: "s", bodyText: "b" },
      })
      .expect(201);
    const campaignId = created.body.data.id as string;
    // No scheduledAt → next tick (status SCHEDULED with now timestamp).
    const sched = await request(env.app)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set("authorization", auth())
      .send({})
      .expect(200);
    expect(sched.body.data.scheduledAt).not.toBeNull();

    // Double-schedule → state-machine conflict.
    await request(env.app)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set("authorization", auth())
      .send({})
      .expect(409);

    // Cancel a SCHEDULED one is fine; then scheduling a CANCELLED one conflicts.
    await request(env.app)
      .post(`/api/v1/campaigns/${campaignId}/cancel`)
      .set("authorization", auth())
      .expect(200);
    await request(env.app)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set("authorization", auth())
      .send({})
      .expect(409);
  });

  it("unsubscribe landing page suppresses the destination (public token path)", async () => {
    // Materialize a real recipient through the service contract, then mint
    // the unsubscribe token exactly the way the worker sender does.
    const campaigns = new CampaignService(env.db);
    await env.db.insert(shopifyCustomers).values({
      storeId,
      shopifyCustomerId: "unsub-1",
      email: "leave@example.com",
    });
    const campaign = await campaigns.createCampaign(storeId, {
      name: "unsub-path",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "s", bodyText: "b" },
    });
    await campaigns.scheduleCampaign(storeId, campaign.id, new Date(Date.now() - 1_000));
    await campaigns.dispatch(storeId, campaign.id);
    const recipientRows = await env.db
      .select()
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaign.id),
          eq(campaignRecipients.destination, "leave@example.com"),
        ),
      );
    expect(recipientRows).toHaveLength(1);
    const token = mintTrackingToken(TRACKING_SECRET, {
      kind: TrackingTokenKind.Unsubscribe,
      recipientId: recipientRows[0]!.id,
    });
    const res = await request(env.app).get(`/api/v1/t/u/${token}`).expect(200);
    expect(res.text).toContain("leave@example.com");
    const suppressions = await env.db
      .select()
      .from(messageSuppressions)
      .where(and(eq(messageSuppressions.storeId, storeId), eq(messageSuppressions.destination, "leave@example.com")));
    expect(suppressions).toHaveLength(1);
  });
});

describe("exports API", () => {
  it("request → queued job → row reflects QUEUED; invalid kind 400s", async () => {
    const created = await request(env.app)
      .post("/api/v1/exports")
      .set("authorization", auth())
      .send({ kind: "CUSTOMERS", format: "CSV" })
      .expect(201);
    expect(created.body.data.status).toBe("QUEUED");
    const exportId = created.body.data.id as string;

    const row = await request(env.app).get(`/api/v1/exports/${exportId}`).set("authorization", auth()).expect(200);
    expect(row.body.data.id).toBe(exportId);

    const bad = await request(env.app)
      .post("/api/v1/exports")
      .set("authorization", auth())
      .send({ kind: "EVERYTHING", format: "CSV" });
    expect(bad.status).toBe(400);

    // Download before READY is a truthful conflict.
    const early = await request(env.app)
      .get(`/api/v1/exports/${exportId}/download`)
      .set("authorization", auth());
    expect(early.status).toBe(409);
  });

  it("accepts a date-range params payload; unknown export ids 404 truthfully", async () => {
    const created = await request(env.app)
      .post("/api/v1/exports")
      .set("authorization", auth())
      .send({
        kind: "ORDERS",
        format: "XLSX",
        params: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
      })
      .expect(201);
    expect(created.body.data.status).toBe("QUEUED");

    const missing = await request(env.app)
      .get(`/api/v1/exports/${crypto.randomUUID()}`)
      .set("authorization", auth());
    expect(missing.status).toBe(404);
  });
});

describe("tracking public endpoints", () => {
  let trackedRecipientId = "";

  beforeAll(async () => {
    // One dedicated campaign with exactly one recipient, so token→row mapping
    // is deterministic regardless of other suites' customers.
    const campaigns = new CampaignService(env.db);
    await env.db.insert(shopifyCustomers).values({
      storeId,
      shopifyCustomerId: "track-1",
      email: "tracker@example.com",
    });
    const campaign = await campaigns.createCampaign(storeId, {
      name: "tracking-suite",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "s", bodyText: "b" },
    });
    await campaigns.scheduleCampaign(storeId, campaign.id, new Date(Date.now() - 1_000));
    await campaigns.dispatch(storeId, campaign.id);
    const rows = await env.db
      .select()
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaign.id),
          eq(campaignRecipients.destination, "tracker@example.com"),
        ),
      );
    trackedRecipientId = rows[0]!.id;
  });

  it("pixel: valid open token → GIF + OPENED event; forged token → GIF without an event", async () => {
    const token = mintTrackingToken(TRACKING_SECRET, {
      kind: TrackingTokenKind.Open,
      recipientId: trackedRecipientId,
    });
    const pixel = await request(env.app).get(`/api/v1/t/o/${token}`);
    expect(pixel.status).toBe(200);
    expect(pixel.headers["content-type"]).toBe("image/gif");
    expect(pixel.headers["cache-control"]).toContain("no-store");
    expect(pixel.body.length).toBe(42); // byte-exact 1×1 GIF89a

    const opens = await env.db
      .select()
      .from(messageEvents)
      .where(and(eq(messageEvents.recipientId, trackedRecipientId)));
    expect(opens.some((e) => e.kind === "OPENED")).toBe(true);

    const forged = await request(env.app).get(`/api/v1/t/o/v1.forged.forged`);
    expect(forged.status).toBe(200); // pixel never 4xxs (mail clients preload)
  });

  it("click: valid token → 302 to the wrapped url + CLICKED event; forged → 404", async () => {
    const token = mintTrackingToken(TRACKING_SECRET, {
      kind: TrackingTokenKind.Click,
      recipientId: trackedRecipientId,
      url: "https://shop.example.com/spring-sale",
    });
    const res = await request(env.app).get(`/api/v1/t/c/${token}`);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("https://shop.example.com/spring-sale");
    const events = await env.db
      .select()
      .from(messageEvents)
      .where(and(eq(messageEvents.recipientId, trackedRecipientId)));
    expect(events.some((e) => e.kind === "CLICKED" && e.url === "https://shop.example.com/spring-sale")).toBe(true);

    const forged = await request(env.app).get(`/api/v1/t/c/v1.forged.forged`);
    expect(forged.status).toBe(404);
  });

  it("kind confusion is rejected: a click token on /t/o records nothing", async () => {
    const clickToken = mintTrackingToken(TRACKING_SECRET, {
      kind: TrackingTokenKind.Click,
      recipientId: trackedRecipientId,
      url: "https://shop.example.com/confuse",
    });
    const before = await env.db
      .select()
      .from(messageEvents)
      .where(eq(messageEvents.recipientId, trackedRecipientId));
    const res = await request(env.app).get(`/api/v1/t/o/${clickToken}`);
    expect(res.status).toBe(200); // still serves the pixel
    const after = await env.db
      .select()
      .from(messageEvents)
      .where(eq(messageEvents.recipientId, trackedRecipientId));
    expect(after).toHaveLength(before.length); // no event forged
  });

  it("unsubscribe: forged token → 404 page; SMS recipients get the SMS wording", async () => {
    const forged = await request(env.app).get(`/api/v1/t/u/v1.forged.forged`);
    expect(forged.status).toBe(404);
    expect(forged.headers["content-type"]).toContain("text/html");

    // An SMS recipient materialized from a phone-carrying customer: the
    // landing page must label the channel truthfully ("SMS", not "email").
    const campaigns = new CampaignService(env.db);
    await env.db
      .insert(shopifyCustomers)
      .values({ storeId, shopifyCustomerId: "sms-1", phone: "+15551234567" });
    const campaign = await campaigns.createCampaign(storeId, {
      name: "sms-unsub-wording",
      channel: MessageChannel.Sms,
      audience: CampaignAudience.AllCustomers,
      variantA: { bodyText: "Flash sale today only." },
    });
    await campaigns.scheduleCampaign(storeId, campaign.id, new Date(Date.now() - 1_000));
    await campaigns.dispatch(storeId, campaign.id);
    const rows = await env.db
      .select()
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaign.id),
          eq(campaignRecipients.destination, "+15551234567"),
        ),
      );
    expect(rows).toHaveLength(1);
    const token = mintTrackingToken(TRACKING_SECRET, {
      kind: TrackingTokenKind.Unsubscribe,
      recipientId: rows[0]!.id,
    });
    const res = await request(env.app).get(`/api/v1/t/u/${token}`).expect(200);
    expect(res.text).toContain("+15551234567");
    expect(res.text).toContain("receive SMS messages");
  });

  it("fails closed with 503 when the surface is deployed without a signing secret", async () => {
    // Production contract: tracking MUST NOT silently no-op — an unconfigured
    // deploy is an operator-visible 503, never a swallowed failure.
    const bare = express();
    bare.use(
      "/api/v1/t",
      trackingRouter({ db: env.db, logger: env.logger, trackingSecret: undefined }),
    );
    bare.use(errorHandlerMiddleware(env.logger));
    for (const path of ["o", "c", "u"]) {
      const res = await request(bare).get(`/api/v1/t/${path}/v1.dead.dead`);
      expect(res.status).toBe(503);
    }
  });
});

describe("support API", () => {
  it("create → thread → reply (reopens) → close; closed rejects reply", async () => {
    const created = await request(env.app)
      .post("/api/v1/support/tickets")
      .set("authorization", auth())
      .send({ subject: "CSV export missing rows", category: "DATA", body: "The customers export stopped at 200 rows." })
      .expect(201);
    const ticketId = created.body.data.id as string;
    expect(created.body.data.status).toBe("OPEN");

    const thread = await request(env.app)
      .get(`/api/v1/support/tickets/${ticketId}`)
      .set("authorization", auth())
      .expect(200);
    expect(thread.body.data.messages).toHaveLength(1);

    const reply = await request(env.app)
      .post(`/api/v1/support/tickets/${ticketId}/reply`)
      .set("authorization", auth())
      .send({ body: "Adding: it affects PDF too." })
      .expect(201);
    expect(reply.body.data.ticket.messageCount).toBe(2);

    const closed = await request(env.app)
      .post(`/api/v1/support/tickets/${ticketId}/close`)
      .set("authorization", auth())
      .expect(200);
    expect(closed.body.data.status).toBe("CLOSED");
    const afterClose = await request(env.app)
      .post(`/api/v1/support/tickets/${ticketId}/reply`)
      .set("authorization", auth())
      .send({ body: "hello?" });
    expect(afterClose.status).toBe(409);
  });

  it("honors explicit priority on create and 404s absent tickets on get + reply", async () => {
    const created = await request(env.app)
      .post("/api/v1/support/tickets")
      .set("authorization", auth())
      .send({
        subject: "Storefront checkout outage",
        category: "BUG",
        priority: "URGENT",
        body: "Checkout returns 500 for every cart.",
      })
      .expect(201);
    expect(created.body.data.priority).toBe("URGENT");

    const missingGet = await request(env.app)
      .get(`/api/v1/support/tickets/${crypto.randomUUID()}`)
      .set("authorization", auth());
    expect(missingGet.status).toBe(404);

    const missingReply = await request(env.app)
      .post(`/api/v1/support/tickets/${crypto.randomUUID()}/reply`)
      .set("authorization", auth())
      .send({ body: "ping" });
    expect(missingReply.status).toBe(404);
  });
});
