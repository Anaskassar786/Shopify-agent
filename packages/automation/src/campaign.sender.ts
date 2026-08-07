import {
  and,
  eq,
  sql,
  withStoreScope,
  campaignRecipients,
  campaigns,
  messageEvents,
  messageSuppressions,
  shopifyCustomers,
  stores,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { BillingService } from "@profit/billing";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  CampaignVariant,
  MessageChannel,
  MessageEventKind,
  TrackingTokenKind,
  UsageMeter,
} from "@profit/types";
import type { VariantPayload } from "./campaign.service";
import { renderTemplate, type MessageTemplateContext, type TemplateCustomerContext } from "./template";
import { injectTracking, mintTrackingToken } from "./tracking";
import { MessageSendError, type MessageEmailSender, type SmsSender } from "./ports";

/**
 * CampaignSender (M6): throttled, quota-guarded, suppression-aware batch
 * sends. Every recipient outcome is a single transaction (recipient row +
 * message event), so a crash mid-batch leaves a truthful ledger and the
 * keyset-cursor chain resumes without re-sending (terminal rows are never
 * re-selected by nextPendingBatch).
 *
 * Tracking injection (email): every http(s) link in the HTML body is
 * rewritten through /t/c/<token> and a 1×1 pixel closes the body — all with
 * per-recipient signed tokens. SMS bodies go verbatim (no rewriting).
 */

export interface CampaignSenderDeps {
  readonly db: ProfitDb;
  readonly email: MessageEmailSender | null;
  readonly sms: SmsSender | null;
  readonly billing?: BillingService;
  /** Required for tracked sends; tracking degrades to plain links when absent. */
  readonly trackingSecret: string | null;
  /** Public base URL for tracking links (e.g. https://api.example.com). */
  readonly trackingBaseUrl: string;
  readonly batchSize: number;
}

export const CAMPAIGN_SEND_DEFAULTS = {
  batchSize: 50,
} as const;

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

interface RecipientRow {
  readonly id: string;
  readonly storeId: string;
  readonly destination: string;
  readonly variant: string;
  readonly customerId: string | null;
}

export interface BatchOutcome {
  readonly processed: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  /** True when no PENDING recipients remain — the chain should terminate. */
  readonly exhausted: boolean;
  /** Fatal quota/config denial — caller marks the campaign FAILED. */
  readonly fatalError: string | null;
  readonly lastRecipientId: string | null;
}

export class CampaignSender {
  private readonly billing: BillingService;

  constructor(private readonly deps: CampaignSenderDeps) {
    this.billing = deps.billing ?? new BillingService(deps.db);
  }

  async sendBatch(
    storeId: string,
    campaignId: string,
    afterRecipientId: string | null,
  ): Promise<BatchOutcome> {
    const campaignRows = await withStoreScope(this.deps.db, storeId, async (tx) =>
      tx
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.storeId, storeId)))
        .limit(1),
    );
    const campaign = campaignRows[0];
    if (campaign === undefined || campaign.status !== CampaignStatus.Sending) {
      return { processed: 0, sent: 0, failed: 0, skipped: 0, exhausted: true, fatalError: null, lastRecipientId: afterRecipientId };
    }

    const meter = campaign.channel === MessageChannel.Email ? UsageMeter.EmailsSent : UsageMeter.SmsSent;
    const quota = await this.billing.checkEntitlement(storeId, meter, this.deps.batchSize);
    if (quota !== null) {
      return { processed: 0, sent: 0, failed: 0, skipped: 0, exhausted: true, fatalError: quota.message, lastRecipientId: afterRecipientId };
    }

    const batch = await withStoreScope(this.deps.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          id: campaignRecipients.id,
          storeId: campaignRecipients.storeId,
          destination: campaignRecipients.destination,
          variant: campaignRecipients.variant,
          customerId: campaignRecipients.customerId,
        })
        .from(campaignRecipients)
        .where(
          afterRecipientId !== null
            ? and(
                eq(campaignRecipients.campaignId, campaignId),
                eq(campaignRecipients.status, CampaignRecipientStatus.Pending),
                sql`${campaignRecipients.id} > ${afterRecipientId}`,
              )
            : and(
                eq(campaignRecipients.campaignId, campaignId),
                eq(campaignRecipients.status, CampaignRecipientStatus.Pending),
              ),
        )
        .orderBy(campaignRecipients.id)
        .limit(this.deps.batchSize);
      return rows;
    });

    if (batch.length === 0) {
      return { processed: 0, sent: 0, failed: 0, skipped: 0, exhausted: true, fatalError: null, lastRecipientId: afterRecipientId };
    }

    const storeInfo = await this.loadStore(storeId);
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let lastRecipientId = afterRecipientId;

    for (const recipient of batch) {
      lastRecipientId = recipient.id;
      const outcome = await this.deliverOne(storeInfo, campaign, recipient);
      if (outcome === CampaignRecipientStatus.Sent) sent += 1;
      if (outcome === CampaignRecipientStatus.Failed) failed += 1;
      if (outcome === CampaignRecipientStatus.Skipped) skipped += 1;
    }

    // Convergent counters: re-derived from the ledger, never incremented blind.
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      const counts = await tx
        .select({
          status: campaignRecipients.status,
          total: sql<number>`count(*)::int`,
        })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, campaignId))
        .groupBy(campaignRecipients.status);
      const byStatus = new Map(counts.map((c) => [c.status, c.total]));
      await tx
        .update(campaigns)
        .set({
          sentCount: byStatus.get(CampaignRecipientStatus.Sent) ?? 0,
          failedCount: byStatus.get(CampaignRecipientStatus.Failed) ?? 0,
          skippedCount: byStatus.get(CampaignRecipientStatus.Skipped) ?? 0,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId));
    });

    const remaining = await withStoreScope(this.deps.db, storeId, async (tx) => {
      const rows = await tx
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients)
        .where(and(eq(campaignRecipients.campaignId, campaignId), eq(campaignRecipients.status, CampaignRecipientStatus.Pending)))
        .limit(1);
      return rows.length;
    });

    return {
      processed: batch.length,
      sent,
      failed,
      skipped,
      exhausted: remaining === 0,
      fatalError: null,
      lastRecipientId,
    };
  }

  /** One recipient, one transaction of record. Returns the terminal status. */
  private async deliverOne(
    storeInfo: { readonly storeId: string; readonly name: string; readonly shopDomain: string },
    campaign: typeof campaigns.$inferSelect,
    recipient: RecipientRow,
  ): Promise<(typeof CampaignRecipientStatus)[keyof typeof CampaignRecipientStatus]> {
    const channel = campaign.channel;
    try {
      if (channel === MessageChannel.Email && this.deps.email === null) {
        throw new MessageSendError("email provider not configured (SMTP env missing)", true);
      }
      if (channel === MessageChannel.Sms && this.deps.sms === null) {
        throw new MessageSendError("sms provider not configured (Twilio env missing)", true);
      }
      if (channel === MessageChannel.Sms && !E164_PATTERN.test(recipient.destination)) {
        return this.recordSkip(storeInfo.storeId, campaign.id, recipient, "destination is not E.164");
      }
      const suppressed = await this.isSuppressed(storeInfo.storeId, channel, recipient.destination);
      if (suppressed) return this.recordSkip(storeInfo.storeId, campaign.id, recipient, "suppressed (unsubscribed)");

      const customer = await this.loadCustomer(storeInfo.storeId, recipient.customerId);
      const variant = this.variantFor(campaign, recipient.variant);
      const context: MessageTemplateContext = {
        store: { name: storeInfo.name, domain: storeInfo.shopDomain },
        customer,
        campaign: { name: campaign.name },
      };

      if (channel === MessageChannel.Email) {
        const subject = renderTemplate(variant.subject ?? "", context);
        const textBody = renderTemplate(variant.bodyText, context);
        let htmlBody = renderTemplate(
          variant.bodyHtml ?? textBody.split("\n").map((l) => `<p>${l}</p>`).join(""),
          context,
          { html: true },
        );
        if (this.deps.trackingSecret !== null) {
          htmlBody = injectTracking(htmlBody, {
            openUrl: `${this.deps.trackingBaseUrl}/api/v1/t/o/${mintTrackingToken(this.deps.trackingSecret, { kind: TrackingTokenKind.Open, recipientId: recipient.id })}`,
            clickUrlFor: (target) =>
              `${this.deps.trackingBaseUrl}/api/v1/t/c/${mintTrackingToken(this.deps.trackingSecret!, { kind: TrackingTokenKind.Click, recipientId: recipient.id, url: target })}`,
          });
        }
        const result = await this.deps.email!.send({ to: recipient.destination, subject, textBody, htmlBody });
        return this.recordSend(storeInfo.storeId, campaign.id, recipient, result.messageId);
      }

      const body = renderTemplate(variant.bodyText, context);
      const result = await this.deps.sms!.send({ to: recipient.destination, body });
      return this.recordSend(storeInfo.storeId, campaign.id, recipient, result.providerRef);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown send error";
      return this.recordFailure(storeInfo.storeId, campaign.id, recipient, message);
    }
  }

  private variantFor(campaign: typeof campaigns.$inferSelect, variant: string): VariantPayload {
    if (variant === CampaignVariant.B && campaign.variantB !== null) {
      return campaign.variantB as VariantPayload;
    }
    return campaign.variantA as VariantPayload;
  }

  private async isSuppressed(
    storeId: string,
    channel: (typeof MessageChannel)[keyof typeof MessageChannel],
    destination: string,
  ): Promise<boolean> {
    return withStoreScope(this.deps.db, storeId, async (tx) => {
      const rows = await tx
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
    });
  }

  private async loadCustomer(
    storeId: string,
    customerId: string | null,
  ): Promise<TemplateCustomerContext | null> {
    if (customerId === null) return null;
    return withStoreScope(this.deps.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          firstName: shopifyCustomers.firstName,
          lastName: shopifyCustomers.lastName,
          email: shopifyCustomers.email,
          ordersCount: shopifyCustomers.ordersCount,
          totalSpent: shopifyCustomers.totalSpent,
        })
        .from(shopifyCustomers)
        .where(and(eq(shopifyCustomers.id, customerId), eq(shopifyCustomers.storeId, storeId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        ordersCount: row.ordersCount,
        totalSpent: `$${Number(row.totalSpent).toFixed(2)}`,
      };
    });
  }

  private async recordSend(
    storeId: string,
    campaignId: string,
    recipient: RecipientRow,
    providerRef: string | null,
  ): Promise<typeof CampaignRecipientStatus.Sent> {
    const now = new Date();
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .update(campaignRecipients)
        .set({
          status: CampaignRecipientStatus.Sent,
          sentAt: now,
          providerRef,
          attempts: sql`${campaignRecipients.attempts} + 1`,
          updatedAt: now,
        })
        .where(eq(campaignRecipients.id, recipient.id));
      await tx.insert(messageEvents).values({
        storeId,
        campaignId,
        recipientId: recipient.id,
        kind: MessageEventKind.Sent,
        metadata: { variant: recipient.variant, providerRef },
      });
    });
    return CampaignRecipientStatus.Sent;
  }

  private async recordFailure(
    storeId: string,
    campaignId: string,
    recipient: RecipientRow,
    error: string,
  ): Promise<typeof CampaignRecipientStatus.Failed> {
    const now = new Date();
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .update(campaignRecipients)
        .set({
          status: CampaignRecipientStatus.Failed,
          lastError: error,
          attempts: sql`${campaignRecipients.attempts} + 1`,
          updatedAt: now,
        })
        .where(eq(campaignRecipients.id, recipient.id));
      await tx.insert(messageEvents).values({
        storeId,
        campaignId,
        recipientId: recipient.id,
        kind: MessageEventKind.Failed,
        metadata: { error: error.slice(0, 500) },
      });
    });
    return CampaignRecipientStatus.Failed;
  }

  private async recordSkip(
    storeId: string,
    campaignId: string,
    recipient: RecipientRow,
    reason: string,
  ): Promise<typeof CampaignRecipientStatus.Skipped> {
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .update(campaignRecipients)
        .set({ status: CampaignRecipientStatus.Skipped, lastError: reason, updatedAt: new Date() })
        .where(eq(campaignRecipients.id, recipient.id));
    });
    return CampaignRecipientStatus.Skipped;
  }

  private async loadStore(storeId: string): Promise<{ readonly storeId: string; readonly name: string; readonly shopDomain: string }> {
    const rows = await this.deps.db
      .select({ name: stores.name, shopDomain: stores.shopDomain })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new MessageSendError("store not found for campaign send", false);
    return { storeId, name: row.name, shopDomain: row.shopDomain };
  }
}
