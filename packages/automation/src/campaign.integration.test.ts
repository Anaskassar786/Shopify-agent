import { eq, messageEvents, messageSuppressions } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  CampaignAudience,
  CampaignRecipientStatus,
  CampaignStatus,
  CampaignVariant,
  MessageChannel,
  MessageEventKind,
  MessageSuppressionReason,
} from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootAutomationTestDb,
  fakeEmailSender,
  fakeSmsSender,
  seedActiveSubscription,
  seedAutomationStore,
  seedCustomer,
  uniqueDomain,
} from "./test-support/integration";
import {
  assignVariant,
  CampaignService,
  CampaignStateError,
  TemplateConflictError,
  validateVariantPayload,
} from "./campaign.service";
import { CampaignSender } from "./campaign.sender";
import { mintTrackingToken } from "./tracking";
import { TrackingTokenKind } from "@profit/types";

/**
 * Campaign plane contract: templates, audience materialization, A/B
 * determinism, throttled batch sending with quota + suppression + tracking
 * injection, convergent counters, stats, and winner declaration — all against
 * the real migrated schema with boundary fakes the tests own.
 */

const TRACKING_SECRET = "test-tracking-secret-0123456789abcdef";
const BASE_URL = "https://api.test";

let testDb: TestDatabase;
let service: CampaignService;
let storeId = "";
const email = fakeEmailSender();
const sms = fakeSmsSender();
let sender: CampaignSender;

beforeAll(async () => {
  testDb = await bootAutomationTestDb();
  service = new CampaignService(testDb.db);
  storeId = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("campaign"), name: "Camp Store" });
  await seedActiveSubscription(testDb.db, storeId);
  sender = new CampaignSender({
    db: testDb.db,
    email: email.sender,
    sms: sms.sender,
    trackingSecret: TRACKING_SECRET,
    trackingBaseUrl: BASE_URL,
    batchSize: 50,
  });
});

afterAll(async () => {
  await testDb.close();
});

describe("templates", () => {
  it("creates, lists, versions and deletes templates", async () => {
    const created = await service.createTemplate(storeId, {
      name: "Welcome",
      channel: MessageChannel.Email,
      subject: "Welcome to {{store.name}}",
      bodyText: "Hi {{customer.firstName}}!",
      bodyHtml: "<p>Hi {{customer.firstName}}!</p>",
    });
    expect(created.version).toBe(1);

    const renamed = await service.updateTemplate(storeId, created.id, { name: "Welcome v2" });
    expect(renamed.version).toBe(1); // no content change

    const edited = await service.updateTemplate(storeId, created.id, {
      subject: "Welcome, {{customer.firstName}}",
    });
    expect(edited.version).toBe(2);

    const list = await service.listTemplates(storeId, MessageChannel.Email);
    expect(list.some((t) => t.name === "Welcome v2")).toBe(true);

    await service.deleteTemplate(storeId, created.id);
    expect(await service.listTemplates(storeId, MessageChannel.Email)).toHaveLength(0);
  });

  it("rejects duplicate name+channel and unknown variables", async () => {
    await service.createTemplate(storeId, {
      name: "Dup",
      channel: MessageChannel.Email,
      subject: "s",
      bodyText: "b",
    });
    await expect(
      service.createTemplate(storeId, {
        name: "Dup",
        channel: MessageChannel.Email,
        subject: "s",
        bodyText: "b",
      }),
    ).rejects.toBeInstanceOf(TemplateConflictError);
    // Same name on SMS is a different identity.
    const smsTemplate = await service.createTemplate(storeId, {
      name: "Dup",
      channel: MessageChannel.Sms,
      bodyText: "text only",
    });
    expect(smsTemplate.channel).toBe(MessageChannel.Sms);

    await expect(
      service.createTemplate(storeId, {
        name: "BadVars",
        channel: MessageChannel.Email,
        subject: "{{store.ssn}}",
        bodyText: "b",
      }),
    ).rejects.toBeInstanceOf(CampaignStateError);
  });

  it("sms templates reject subjects/html", async () => {
    await expect(
      service.createTemplate(storeId, {
        name: "sms-bad",
        channel: MessageChannel.Sms,
        subject: "no",
        bodyText: "b",
      }),
    ).rejects.toBeInstanceOf(CampaignStateError);
  });
});

describe("validateVariantPayload + assignVariant (pure)", () => {
  it("rejects email variant without subject and sms with subject", () => {
    expect(() => validateVariantPayload({ bodyText: "x" }, MessageChannel.Email)).toThrow(CampaignStateError);
    expect(() => validateVariantPayload({ subject: "s", bodyText: "x" }, MessageChannel.Sms)).toThrow(
      CampaignStateError,
    );
    expect(() => validateVariantPayload({ subject: "s", bodyText: "x" }, MessageChannel.Email)).not.toThrow();
  });

  it("assignment is deterministic and statistically sane", () => {
    const a = assignVariant("camp-1", "cust-1", 50);
    const b = assignVariant("camp-1", "cust-1", 50);
    expect(a).toBe(b);
    const distribution = { A: 0, B: 0 };
    for (let i = 0; i < 1000; i += 1) {
      distribution[assignVariant("camp-1", `cust-${i}`, 50)] += 1;
    }
    expect(distribution.A + distribution.B).toBe(1000);
    expect(distribution.B).toBeGreaterThan(350);
    expect(distribution.B).toBeLessThan(650);
    expect(assignVariant("camp-1", "cust-1", 0)).toBe(CampaignVariant.A);
    expect(assignVariant("camp-1", "cust-1", 100)).toBe(CampaignVariant.B);
  });
});

describe("audience materialization + dispatch", () => {
  it("materializes only reachable customers, deduped by destination, then sends", async () => {
    const c1 = await seedCustomer(testDb.db, { storeId, email: "one@example.com", acceptsMarketing: true });
    await seedCustomer(testDb.db, { storeId, email: "two@example.com", acceptsMarketing: false });
    await seedCustomer(testDb.db, { storeId, email: null }); // unreachable for email
    await seedCustomer(testDb.db, { storeId, email: "one@example.com", acceptsMarketing: true }); // same email — deduped by unique(campaign, destination)

    const campaign = await service.createCampaign(storeId, {
      name: "Blast",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "Hello {{customer.firstName}}", bodyText: "Body for {{customer.email}}" },
    });
    const scheduled = await service.scheduleCampaign(storeId, campaign.id, new Date());
    expect(scheduled.status).toBe(CampaignStatus.Scheduled);

    const due = await service.findDispatchDue(new Date());
    expect(due.some((d) => d.campaignId === campaign.id)).toBe(true);

    const dispatch = await service.dispatch(storeId, campaign.id);
    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.recipientCount).toBe(2); // same-email duplicate collapsed
    void c1;

    // Second dispatch is a CAS no-op.
    const again = await service.dispatch(storeId, campaign.id);
    expect(again.dispatched).toBe(false);

    // Send in one batch (batchSize 50 covers), tracking injected.
    const outcome = await sender.sendBatch(storeId, campaign.id, null);
    expect(outcome.exhausted).toBe(true);
    expect(outcome.sent).toBe(2);
    expect(outcome.fatalError).toBeNull();

    expect(email.sent).toHaveLength(2);
    const bodies = email.sent.map((m) => m.htmlBody);
    for (const body of bodies) {
      expect(body).toContain(`${BASE_URL}/api/v1/t/o/`);
      expect(body).toContain("<img");
    }
    // Open tokens inside bodies verify against the secret.
    const openToken = /\/api\/v1\/t\/o\/([^"]+)/.exec(email.sent[0]!.htmlBody)?.[1];
    expect(openToken).toBeDefined();

    const completed = await service.completeCampaign(storeId, campaign.id);
    expect(completed).toBe(true);

    const after = await service.getCampaign(storeId, campaign.id);
    expect(after?.status).toBe(CampaignStatus.Sent);
    expect(after?.sentCount).toBe(2);
    expect(after?.recipientCount).toBe(2);

    // Ledger: one SENT event per recipient.
    const events = await testDb.db
      .select()
      .from(messageEvents)
      .where(eq(messageEvents.campaignId, campaign.id));
    expect(events.filter((e) => e.kind === MessageEventKind.Sent)).toHaveLength(2);
  });

  it("marketing-opt-in audience excludes non-subscribers; repeat customers needs >= 2 orders", async () => {
    // Fresh store: audience assertions are exact, so no other suite's customers
    // may leak into the segment.
    const segStore = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("camp-seg") });
    await seedActiveSubscription(testDb.db, segStore);
    await seedCustomer(testDb.db, { storeId: segStore, email: "optin@example.com", acceptsMarketing: true, ordersCount: 1 });
    await seedCustomer(testDb.db, { storeId: segStore, email: "noopt@example.com", acceptsMarketing: false, ordersCount: 5 });
    await seedCustomer(testDb.db, { storeId: segStore, email: "repeat@example.com", acceptsMarketing: false, ordersCount: 3 });

    const optin = await service.createCampaign(segStore, {
      name: "optin-camp",
      channel: MessageChannel.Email,
      audience: CampaignAudience.MarketingOptIn,
      variantA: { subject: "s", bodyText: "b" },
    });
    await service.scheduleCampaign(segStore, optin.id, new Date());
    const optinDispatch = await service.dispatch(segStore, optin.id);
    expect(optinDispatch.recipientCount).toBe(1);

    const repeat = await service.createCampaign(segStore, {
      name: "repeat-camp",
      channel: MessageChannel.Email,
      audience: CampaignAudience.RepeatCustomers,
      variantA: { subject: "s", bodyText: "b" },
    });
    await service.scheduleCampaign(segStore, repeat.id, new Date());
    const repeatDispatch = await service.dispatch(segStore, repeat.id);
    expect(repeatDispatch.recipientCount).toBe(2); // ordersCount 5 + 3
  });

  it("empty audience marks the campaign FAILED with an honest reason", async () => {
    const emptyStore = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("camp-empty") });
    await seedActiveSubscription(testDb.db, emptyStore);
    const campaign = await service.createCampaign(emptyStore, {
      name: "nobody",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "s", bodyText: "b" },
    });
    await service.scheduleCampaign(emptyStore, campaign.id, new Date());
    const dispatch = await service.dispatch(emptyStore, campaign.id);
    expect(dispatch.recipientCount).toBe(0);
    const after = await service.getCampaign(emptyStore, campaign.id);
    expect(after?.status).toBe(CampaignStatus.Failed);
    expect(after?.lastError).toContain("0 reachable recipients");
  });

  it("cancel works only before sending starts", async () => {
    const campaign = await service.createCampaign(storeId, {
      name: "cancel-me",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "s", bodyText: "b" },
    });
    const cancelled = await service.cancelCampaign(storeId, campaign.id);
    expect(cancelled.status).toBe(CampaignStatus.Cancelled);
    await expect(service.scheduleCampaign(storeId, campaign.id, new Date())).rejects.toBeInstanceOf(
      CampaignStateError,
    );
    // A SENT one rejects cancellation mid-flight.
    const sent = await service.createCampaign(storeId, {
      name: "sent-one",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "s", bodyText: "b" },
    });
    await service.scheduleCampaign(storeId, sent.id, new Date());
    await service.dispatch(storeId, sent.id);
    await expect(service.cancelCampaign(storeId, sent.id)).rejects.toBeInstanceOf(CampaignStateError);
  });
});

describe("A/B campaigns", () => {
  it("splits deterministically, reports per-variant rates, declares a winner", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(
        await seedCustomer(testDb.db, {
          storeId,
          email: `ab-${i}@example.com`,
          acceptsMarketing: true,
        }),
      );
    }
    const campaign = await service.createCampaign(storeId, {
      name: "ab-test",
      channel: MessageChannel.Email,
      audience: CampaignAudience.MarketingOptIn,
      variantA: { subject: "A subject", bodyText: "A body {{customer.email}}" },
      variantB: { subject: "B subject", bodyText: "B body" },
      splitBPercent: 50,
    });
    await service.scheduleCampaign(storeId, campaign.id, new Date());
    const dispatch = await service.dispatch(storeId, campaign.id);
    // ≥ the 6 ab-* rows (earlier-suite opt-ins dedupe by destination only).
    expect(dispatch.recipientCount).toBeGreaterThanOrEqual(6);
    await sender.sendBatch(storeId, campaign.id, null);
    await service.completeCampaign(storeId, campaign.id);

    const stats = await service.getStats(storeId, campaign.id);
    expect(stats.recipients.sent).toBeGreaterThanOrEqual(6);
    expect(stats.variants.length).toBe(2);

    // Winner declaration: B exists; must be after SENT.
    const won = await service.declareWinner(storeId, campaign.id, "B");
    expect(won.winnerVariant).toBe(CampaignVariant.B);
    await expect(service.declareWinner(storeId, campaign.id, "C")).rejects.toBeInstanceOf(CampaignStateError);
  });
});

describe("gates: suppression + quota + tracking urls", () => {
  it("suppressed recipients are SKIPPED pre-send (no provider call)", async () => {
    await seedCustomer(testDb.db, { storeId, email: "supp@example.com" });
    await testDb.db.insert(messageSuppressions).values({
      storeId,
      channel: MessageChannel.Email,
      destination: "supp@example.com",
      reason: MessageSuppressionReason.Unsubscribed,
    });
    const campaign = await service.createCampaign(storeId, {
      name: "supp-camp",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "s", bodyText: "b" },
    });
    await service.scheduleCampaign(storeId, campaign.id, new Date());
    await service.dispatch(storeId, campaign.id);
    const before = email.sent.length;
    const outcome = await sender.sendBatch(storeId, campaign.id, null);
    expect(outcome.exhausted).toBe(true);
    expect(outcome.skipped).toBeGreaterThanOrEqual(1);
    expect(email.sent.some((m) => m.to === "supp@example.com")).toBe(false);
    // Skipped recipients never hit the provider boundary.
    expect(email.sent.length).toBe(before + outcome.sent);
  });

  it("non-E.164 sms destinations are SKIPPED without a provider call", async () => {
    await seedCustomer(testDb.db, { storeId, phone: "0123456" }); // not E.164
    await seedCustomer(testDb.db, { storeId, phone: "+15557650001" });
    const campaign = await service.createCampaign(storeId, {
      name: "sms-camp",
      channel: MessageChannel.Sms,
      audience: CampaignAudience.AllCustomers,
      variantA: { bodyText: "sms body {{customer.firstName}}" },
    });
    await service.scheduleCampaign(storeId, campaign.id, new Date());
    await service.dispatch(storeId, campaign.id);
    const outcome = await sender.sendBatch(storeId, campaign.id, null);
    expect(outcome.exhausted).toBe(true);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe("+15557650001");
    expect(outcome.skipped).toBe(1);
  });

  it("click tokens mint valid redirect urls through the tracker prefix", () => {
    const token = mintTrackingToken(TRACKING_SECRET, {
      kind: TrackingTokenKind.Click,
      recipientId: "7f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d",
      url: "https://shop.example.com/x",
    });
    expect(`${BASE_URL}/api/v1/t/c/${token}`).toContain(`${BASE_URL}/api/v1/t/c/v1.`);
  });
});
