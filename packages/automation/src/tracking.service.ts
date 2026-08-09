import { and, eq, campaignRecipients, campaigns, messageEvents, messageSuppressions } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  MessageEventKind,
  MessageSuppressionReason,
  TrackingTokenKind,
  type MessageChannel as MessageChannelType,
} from "@profit/types";
import { verifyTrackingToken } from "./tracking";

/**
 * TrackingService (M6): the /t/* public endpoint brain. These requests have
 * NO tenant session — authorization is the signed token, and writes run
 * through the owner role by design (documented platform-ops class, same as
 * install/uninstall). Every recording is truthful even when the recipient
 * state moved on (e.g. open after failed send is impossible by construction:
 * tokens only ship inside delivered messages).
 */

export class TrackingRecipientNotFoundError extends Error {
  constructor() {
    super("tracking recipient not found");
    this.name = "TrackingRecipientNotFoundError";
  }
}

export interface TrackedRecipientContext {
  readonly storeId: string;
  readonly campaignId: string;
  readonly recipientId: string;
  readonly destination: string;
  readonly channel: MessageChannelType;
}

export class TrackingService {
  constructor(private readonly db: ProfitDb) {}

  /** Resolve a token's recipient, joining the campaign for the channel. */
  private async resolve(recipientId: string): Promise<TrackedRecipientContext> {
    const rows = await this.db
      .select({
        storeId: campaignRecipients.storeId,
        campaignId: campaignRecipients.campaignId,
        recipientId: campaignRecipients.id,
        destination: campaignRecipients.destination,
        channel: campaigns.channel,
      })
      .from(campaignRecipients)
      .innerJoin(campaigns, eq(campaignRecipients.campaignId, campaigns.id))
      .where(eq(campaignRecipients.id, recipientId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new TrackingRecipientNotFoundError();
    return row;
  }

  /** /t/o — record an open. Returns void; the endpoint serves the pixel either way. */
  async recordOpen(secret: string, token: string): Promise<void> {
    const verified = verifyTrackingToken(secret, token);
    if (verified.kind !== TrackingTokenKind.Open) throw new TrackingRecipientNotFoundError();
    const context = await this.resolve(verified.recipientId);
    await this.db.insert(messageEvents).values({
      storeId: context.storeId,
      campaignId: context.campaignId,
      recipientId: context.recipientId,
      kind: MessageEventKind.Opened,
    });
  }

  /** /t/c — record a click and return the destination URL to redirect to. */
  async recordClick(secret: string, token: string): Promise<{ readonly url: string }> {
    const verified = verifyTrackingToken(secret, token);
    if (verified.kind !== TrackingTokenKind.Click || verified.url === null) {
      throw new TrackingRecipientNotFoundError();
    }
    const context = await this.resolve(verified.recipientId);
    await this.db.insert(messageEvents).values({
      storeId: context.storeId,
      campaignId: context.campaignId,
      recipientId: context.recipientId,
      kind: MessageEventKind.Clicked,
      url: verified.url,
    });
    return { url: verified.url };
  }

  /**
   * /t/u — unsubscribe the destination from this channel (compliance).
   * Idempotent by the (store, channel, destination) unique index.
   */
  async recordUnsubscribe(secret: string, token: string): Promise<{
    readonly destination: string;
    readonly channel: MessageChannelType;
  }> {
    const verified = verifyTrackingToken(secret, token);
    if (verified.kind !== TrackingTokenKind.Unsubscribe) throw new TrackingRecipientNotFoundError();
    const context = await this.resolve(verified.recipientId);
    await this.db.insert(messageEvents).values({
      storeId: context.storeId,
      campaignId: context.campaignId,
      recipientId: context.recipientId,
      kind: MessageEventKind.Unsubscribed,
    });
    await this.db
      .insert(messageSuppressions)
      .values({
        storeId: context.storeId,
        channel: context.channel,
        destination: context.destination,
        reason: MessageSuppressionReason.Unsubscribed,
        note: `via campaign ${context.campaignId}`,
      })
      .onConflictDoNothing({
        target: [
          messageSuppressions.storeId,
          messageSuppressions.channel,
          messageSuppressions.destination,
        ],
      });
    return { destination: context.destination, channel: context.channel };
  }

  /** Suppression state probe used by internal preflight checks (not the public API). */
  async isSuppressedDestination(
    storeId: string,
    channel: MessageChannelType,
    destination: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: messageSuppressions.id })
      .from(messageSuppressions)
      .where(
        and(
          eq(messageSuppressions.storeId, storeId),
          eq(messageSuppressions.channel, channel),
          eq(messageSuppressions.destination, destination),
        ),
      )
      .limit(1);
    return rows[0] !== undefined;
  }
}
