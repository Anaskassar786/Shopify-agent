import { and, campaignRecipients, eq, messageEvents, messageSuppressions } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  CampaignAudience,
  CampaignStatus,
  MessageChannel,
  MessageEventKind,
  MessageSuppressionReason,
  TrackingTokenKind,
} from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootAutomationTestDb,
  fakeEmailSender,
  seedActiveSubscription,
  seedAutomationStore,
  seedCustomer,
  uniqueDomain,
} from "./test-support/integration";
import { CampaignService } from "./campaign.service";
import { CampaignSender } from "./campaign.sender";
import { mintTrackingToken } from "./tracking";
import { TrackingService, TrackingRecipientNotFoundError } from "./tracking.service";

/**
 * Tracking endpoint contract: signed-token → ledger. Every event lands with
 * the right store/campaign attribution through owner-role writes (no tenant
 * session exists on /t/* — the token is the authorization), and unsubscribe
 * is idempotent against the suppression unique index.
 */

const SECRET = "test-tracking-secret-0123456789abcdef";
let testDb: TestDatabase;
let storeId = "";
let campaignId = "";
let recipientId = "";

beforeAll(async () => {
  testDb = await bootAutomationTestDb();
  storeId = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("tracking") });
  await seedActiveSubscription(testDb.db, storeId);
  await seedCustomer(testDb.db, { storeId, email: "tracked@example.com" });

  const campaigns = new CampaignService(testDb.db);
  const campaign = await campaigns.createCampaign(storeId, {
    name: "tracked-camp",
    channel: MessageChannel.Email,
    audience: CampaignAudience.AllCustomers,
    variantA: {
      subject: "s",
      bodyText: "b",
      bodyHtml: `<p>Hi</p><a href="https://shop.example.com/p/1">Link</a>`,
    },
  });
  campaignId = campaign.id;
  await campaigns.scheduleCampaign(storeId, campaignId, new Date());
  await campaigns.dispatch(storeId, campaignId);
  const sender = new CampaignSender({
    db: testDb.db,
    email: fakeEmailSender().sender,
    sms: null,
    trackingSecret: SECRET,
    trackingBaseUrl: "https://api.test",
    batchSize: 50,
  });
  await sender.sendBatch(storeId, campaignId, null);

  const rows = await testDb.db
    .select({ id: campaignRecipients.id })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .limit(1);
  recipientId = rows[0]!.id;
});

afterAll(async () => {
  await testDb.close();
});

describe("recordOpen / recordClick / recordUnsubscribe", () => {
  it("records an OPENED event attributed to store + campaign", async () => {
    const service = new TrackingService(testDb.db);
    const token = mintTrackingToken(SECRET, { kind: TrackingTokenKind.Open, recipientId });
    await service.recordOpen(SECRET, token);
    const rows = await testDb.db
      .select()
      .from(messageEvents)
      .where(and(eq(messageEvents.recipientId, recipientId), eq(messageEvents.kind, MessageEventKind.Opened)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.storeId).toBe(storeId);
    expect(rows[0]?.campaignId).toBe(campaignId);
  });

  it("records CLICKED with its URL and returns the redirect target", async () => {
    const service = new TrackingService(testDb.db);
    const token = mintTrackingToken(SECRET, {
      kind: TrackingTokenKind.Click,
      recipientId,
      url: "https://shop.example.com/p/1",
    });
    const result = await service.recordClick(SECRET, token);
    expect(result.url).toBe("https://shop.example.com/p/1");
    const rows = await testDb.db
      .select()
      .from(messageEvents)
      .where(and(eq(messageEvents.recipientId, recipientId), eq(messageEvents.kind, MessageEventKind.Clicked)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe("https://shop.example.com/p/1");
  });

  it("unsubscribe writes the event AND idempotent suppression", async () => {
    const service = new TrackingService(testDb.db);
    const token = mintTrackingToken(SECRET, { kind: TrackingTokenKind.Unsubscribe, recipientId });
    const first = await service.recordUnsubscribe(SECRET, token);
    expect(first.destination).toBe("tracked@example.com");
    expect(first.channel).toBe(MessageChannel.Email);
    // Replay-safe: same token again → still exactly one suppression row.
    await service.recordUnsubscribe(SECRET, token);

    const suppressions = await testDb.db
      .select()
      .from(messageSuppressions)
      .where(
        and(
          eq(messageSuppressions.storeId, storeId),
          eq(messageSuppressions.destination, "tracked@example.com"),
        ),
      );
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]?.reason).toBe(MessageSuppressionReason.Unsubscribed);

    const unsubEvents = await testDb.db
      .select()
      .from(messageEvents)
      .where(and(eq(messageEvents.recipientId, recipientId), eq(messageEvents.kind, MessageEventKind.Unsubscribed)));
    expect(unsubEvents).toHaveLength(2); // raw events stay append-only
  });

  it("kind confusion is rejected (click token at the open endpoint)", async () => {
    const service = new TrackingService(testDb.db);
    const clickToken = mintTrackingToken(SECRET, {
      kind: TrackingTokenKind.Click,
      recipientId,
      url: "https://shop.example.com/x",
    });
    await expect(service.recordOpen(SECRET, clickToken)).rejects.toBeInstanceOf(TrackingRecipientNotFoundError);
  });

  it("tampered or unknown recipients are rejected without writes", async () => {
    const service = new TrackingService(testDb.db);
    const forged = mintTrackingToken(SECRET, {
      kind: TrackingTokenKind.Open,
      recipientId: "00000000-0000-0000-0000-000000000000",
    });
    await expect(service.recordOpen(SECRET, forged)).rejects.toBeInstanceOf(TrackingRecipientNotFoundError);
    await expect(service.recordOpen(`${SECRET}x`, forged)).rejects.toThrow();
  });
});
