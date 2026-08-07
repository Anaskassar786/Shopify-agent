import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  sql,
  withStoreScope,
  campaignRecipients,
  campaigns,
  messageEvents,
  messageSuppressions,
  messageTemplates,
  shopifyCustomers,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  CampaignAudience,
  CampaignRecipientStatus,
  CampaignStatus,
  CampaignVariant,
  MessageChannel,
  MessageEventKind,
  type CampaignAudience as CampaignAudienceType,
  type CampaignStatus as CampaignStatusType,
  type CampaignVariant as CampaignVariantType,
  type MessageChannel as MessageChannelType,
} from "@profit/types";
import { validateTemplateVars } from "./template";

/**
 * CampaignService (M6): template CRUD, campaign CRUD, audience materialization,
 * deterministic A/B assignment, live stats, and winner declaration. The send
 * machinery lives in campaign.sender.ts; this module owns state transitions
 * and read models.
 */

export class CampaignNotFoundError extends Error {
  constructor(id: string) {
    super(`campaign ${id} not found`);
    this.name = "CampaignNotFoundError";
  }
}

export class CampaignStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignStateError";
  }
}

export class TemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`message template ${id} not found`);
    this.name = "TemplateNotFoundError";
  }
}

export class TemplateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateConflictError";
  }
}

export interface VariantPayload {
  readonly templateId?: string;
  readonly subject?: string;
  readonly bodyText: string;
  readonly bodyHtml?: string;
}

export interface CampaignRow {
  readonly id: string;
  readonly name: string;
  readonly channel: MessageChannelType;
  readonly audience: CampaignAudienceType;
  readonly status: CampaignStatusType;
  readonly variantA: unknown;
  readonly variantB: unknown;
  readonly splitBPercent: number;
  readonly winnerVariant: string | null;
  readonly scheduledAt: Date | null;
  readonly sendingStartedAt: Date | null;
  readonly sentAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly recipientCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly lastError: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly channel: MessageChannelType;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const CAMPAIGN_LIMITS = {
  bodyTextMax: 5_000,
  bodyHtmlMax: 20_000,
  subjectMax: 200,
  nameMax: 140,
  maxActivePerStore: 100,
} as const;

/** Deterministic variant assignment: same (campaign, customer) ⇒ same bucket. */
export function assignVariant(campaignId: string, customerId: string, splitBPercent: number): CampaignVariantType {
  if (splitBPercent <= 0) return CampaignVariant.A;
  if (splitBPercent >= 100) return CampaignVariant.B;
  const digest = createHash("sha256").update(`${campaignId}:${customerId}`).digest();
  const bucket = digest[0]! % 100;
  return bucket < splitBPercent ? CampaignVariant.B : CampaignVariant.A;
}

/** Validate inline variant content; throws CampaignStateError on unknown vars or empty bodies. */
export function validateVariantPayload(variant: VariantPayload, channel: MessageChannelType): void {
  if (variant.bodyText.length === 0 || variant.bodyText.length > CAMPAIGN_LIMITS.bodyTextMax) {
    throw new CampaignStateError("variant bodyText must be 1..5000 characters");
  }
  if (channel === MessageChannel.Email) {
    if (variant.subject === undefined || variant.subject.length === 0 || variant.subject.length > CAMPAIGN_LIMITS.subjectMax) {
      throw new CampaignStateError("email variant requires a subject of 1..200 characters");
    }
    const unknown = [
      ...validateTemplateVars(variant.subject),
      ...validateTemplateVars(variant.bodyText),
      ...(variant.bodyHtml !== undefined ? validateTemplateVars(variant.bodyHtml) : []),
    ];
    if (unknown.length > 0) {
      throw new CampaignStateError(`unknown template variables: ${unknown.join(", ")}`);
    }
  } else {
    if (variant.subject !== undefined) throw new CampaignStateError("sms variants must not carry a subject");
    if (variant.bodyHtml !== undefined) throw new CampaignStateError("sms variants must not carry html");
    const unknown = validateTemplateVars(variant.bodyText);
    if (unknown.length > 0) {
      throw new CampaignStateError(`unknown template variables: ${unknown.join(", ")}`);
    }
  }
}

export class CampaignService {
  constructor(private readonly db: ProfitDb) {}

  /* ─── templates ────────────────────────────────────────────────── */

  async listTemplates(storeId: string, channel?: MessageChannelType): Promise<readonly TemplateRow[]> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(messageTemplates)
        .where(
          channel !== undefined
            ? and(eq(messageTemplates.storeId, storeId), eq(messageTemplates.channel, channel))
            : eq(messageTemplates.storeId, storeId),
        )
        .orderBy(desc(messageTemplates.updatedAt));
      return rows.map((r) => this.toTemplateRow(r));
    });
  }

  async createTemplate(
    storeId: string,
    input: {
      name: string;
      channel: MessageChannelType;
      subject?: string | null;
      bodyText: string;
      bodyHtml?: string | null;
    },
  ): Promise<TemplateRow> {
    this.validateTemplateInput(input.channel, input);
    return withStoreScope(this.db, storeId, async (tx) => {
      const duplicate = await tx
        .select({ id: messageTemplates.id })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.storeId, storeId),
            eq(messageTemplates.name, input.name),
            eq(messageTemplates.channel, input.channel),
          ),
        )
        .limit(1);
      if (duplicate[0] !== undefined) {
        throw new TemplateConflictError(`a ${input.channel} template named "${input.name}" already exists`);
      }
      const rows = await tx
        .insert(messageTemplates)
        .values({
          storeId,
          name: input.name,
          channel: input.channel,
          subject: input.subject ?? null,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml ?? null,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new TemplateConflictError("template insert returned no row");
      return this.toTemplateRow(row);
    });
  }

  async updateTemplate(
    storeId: string,
    templateId: string,
    input: {
      name?: string;
      subject?: string | null;
      bodyText?: string;
      bodyHtml?: string | null;
    },
  ): Promise<TemplateRow> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(messageTemplates)
        .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.storeId, storeId)))
        .limit(1);
      const existing = rows[0];
      if (existing === undefined) throw new TemplateNotFoundError(templateId);
      const candidate = {
        channel: existing.channel,
        name: input.name ?? existing.name,
        subject: input.subject === undefined ? existing.subject : input.subject,
        bodyText: input.bodyText ?? existing.bodyText,
        bodyHtml: input.bodyHtml === undefined ? existing.bodyHtml : input.bodyHtml,
      };
      this.validateTemplateInput(existing.channel, candidate);
      const contentChanged =
        candidate.subject !== existing.subject ||
        candidate.bodyText !== existing.bodyText ||
        candidate.bodyHtml !== existing.bodyHtml;
      const updated = await tx
        .update(messageTemplates)
        .set({
          name: candidate.name,
          subject: candidate.subject,
          bodyText: candidate.bodyText,
          bodyHtml: candidate.bodyHtml,
          version: contentChanged ? existing.version + 1 : existing.version,
          updatedAt: new Date(),
        })
        .where(eq(messageTemplates.id, templateId))
        .returning();
      const row = updated[0];
      if (row === undefined) throw new TemplateNotFoundError(templateId);
      return this.toTemplateRow(row);
    });
  }

  async deleteTemplate(storeId: string, templateId: string): Promise<void> {
    await withStoreScope(this.db, storeId, async (tx) => {
      const deleted = await tx
        .delete(messageTemplates)
        .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.storeId, storeId)))
        .returning({ id: messageTemplates.id });
      if (deleted.length === 0) throw new TemplateNotFoundError(templateId);
    });
  }

  private validateTemplateInput(
    channel: MessageChannelType,
    input: { name: string; subject?: string | null; bodyText: string; bodyHtml?: string | null },
  ): void {
    if (input.name.length === 0 || input.name.length > CAMPAIGN_LIMITS.nameMax) {
      throw new CampaignStateError("template name must be 1..140 characters");
    }
    if (input.bodyText.length === 0 || input.bodyText.length > CAMPAIGN_LIMITS.bodyTextMax) {
      throw new CampaignStateError("template bodyText must be 1..5000 characters");
    }
    if (channel === MessageChannel.Email) {
      if (input.subject === null || input.subject === undefined || input.subject.length === 0) {
        throw new CampaignStateError("email templates require a subject");
      }
      const unknown = [
        ...validateTemplateVars(input.subject),
        ...validateTemplateVars(input.bodyText),
        ...(input.bodyHtml !== null && input.bodyHtml !== undefined ? validateTemplateVars(input.bodyHtml) : []),
      ];
      if (unknown.length > 0) throw new CampaignStateError(`unknown template variables: ${unknown.join(", ")}`);
    } else {
      if (input.subject !== null && input.subject !== undefined) {
        throw new CampaignStateError("sms templates must not carry a subject");
      }
      const unknown = validateTemplateVars(input.bodyText);
      if (unknown.length > 0) throw new CampaignStateError(`unknown template variables: ${unknown.join(", ")}`);
    }
  }

  /* ─── campaign CRUD + transitions ──────────────────────────────── */

  async listCampaigns(storeId: string): Promise<readonly CampaignRow[]> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.storeId, storeId))
        .orderBy(desc(campaigns.createdAt));
      return rows.map((r) => this.toRow(r));
    });
  }

  async getCampaign(storeId: string, campaignId: string): Promise<CampaignRow | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.storeId, storeId)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : this.toRow(row);
    });
  }

  /** Resolve template references into immutable inline variant snapshots. */
  async resolveVariant(storeId: string, input: VariantPayload, channel: MessageChannelType): Promise<VariantPayload> {
    const templateId = input.templateId;
    if (templateId === undefined) {
      validateVariantPayload(input, channel);
      return input;
    }
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(messageTemplates)
        .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.storeId, storeId)))
        .limit(1);
      const template = rows[0];
      if (template === undefined) throw new TemplateNotFoundError(templateId);
      if (template.channel !== channel) {
        throw new CampaignStateError(`template channel mismatch: template is ${template.channel}, campaign is ${channel}`);
      }
      const snapshot: VariantPayload = {
        templateId: template.id,
        ...(template.subject !== null ? { subject: template.subject } : {}),
        bodyText: template.bodyText,
        ...(template.bodyHtml !== null ? { bodyHtml: template.bodyHtml } : {}),
      };
      validateVariantPayload(snapshot, channel);
      return snapshot;
    });
  }

  async createCampaign(
    storeId: string,
    input: {
      name: string;
      channel: MessageChannelType;
      audience: CampaignAudienceType;
      variantA: VariantPayload;
      variantB?: VariantPayload;
      splitBPercent?: number;
      createdByUserId?: string | null;
    },
  ): Promise<CampaignRow> {
    if (input.name.length === 0 || input.name.length > CAMPAIGN_LIMITS.nameMax) {
      throw new CampaignStateError("campaign name must be 1..140 characters");
    }
    const variantA = await this.resolveVariant(storeId, input.variantA, input.channel);
    const variantB = input.variantB !== undefined ? await this.resolveVariant(storeId, input.variantB, input.channel) : null;
    const split = input.splitBPercent ?? 50;
    if (split < 0 || split > 100) throw new CampaignStateError("splitBPercent must be 0..100");
    return withStoreScope(this.db, storeId, async (tx) => {
      const activeCount = await tx
        .select({ total: count() })
        .from(campaigns)
        .where(and(eq(campaigns.storeId, storeId), sql`${campaigns.status} <> ${CampaignStatus.Cancelled}`));
      if ((activeCount[0]?.total ?? 0) >= CAMPAIGN_LIMITS.maxActivePerStore) {
        throw new CampaignStateError("campaign limit reached for this store");
      }
      const rows = await tx
        .insert(campaigns)
        .values({
          storeId,
          name: input.name,
          channel: input.channel,
          audience: input.audience,
          status: CampaignStatus.Draft,
          variantA,
          variantB,
          splitBPercent: variantB === null ? 0 : split,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new CampaignStateError("campaign insert returned no row");
      return this.toRow(row);
    });
  }

  /**
   * Schedule (or "send now" with a past/null date → dispatch on next tick).
   * Guarded DRAFT→SCHEDULED so double-clicks can't create two dispatches.
   */
  async scheduleCampaign(storeId: string, campaignId: string, scheduledAt: Date | null, now = new Date()): Promise<CampaignRow> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(campaigns)
        .set({ status: CampaignStatus.Scheduled, scheduledAt: scheduledAt ?? now, updatedAt: now })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.storeId, storeId), eq(campaigns.status, CampaignStatus.Draft)))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        // Same-tx existence check: a nested withStoreScope would open a second
        // transaction against the root handle (deadlock on single-connection
        // drivers like PGlite; invisible uncommitted state elsewhere).
        const exists = await this.existsInTx(tx, campaignId);
        if (!exists) throw new CampaignNotFoundError(campaignId);
        throw new CampaignStateError("only DRAFT campaigns can be scheduled");
      }
      return this.toRow(row);
    });
  }

  async cancelCampaign(storeId: string, campaignId: string, now = new Date()): Promise<CampaignRow> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(campaigns)
        .set({ status: CampaignStatus.Cancelled, cancelledAt: now, updatedAt: now })
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.storeId, storeId),
            sql`${campaigns.status} IN (${CampaignStatus.Draft}, ${CampaignStatus.Scheduled})`,
          ),
        )
        .returning();
      const row = updated[0];
      if (row === undefined) {
        const exists = await this.existsInTx(tx, campaignId);
        if (!exists) throw new CampaignNotFoundError(campaignId);
        throw new CampaignStateError("only DRAFT or SCHEDULED campaigns can be cancelled (sending is irreversible)");
      }
      return this.toRow(row);
    });
  }

  /** SCHEDULED campaigns whose time arrived (TICK scan — owner role). */
  async findDispatchDue(now: Date): Promise<ReadonlyArray<{ storeId: string; campaignId: string }>> {
    const rows = await this.db
      .select({ storeId: campaigns.storeId, campaignId: campaigns.id })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.status, CampaignStatus.Scheduled),
          isNotNull(campaigns.scheduledAt),
          sql`${campaigns.scheduledAt} <= ${now}`,
        ),
      )
      .orderBy(asc(campaigns.scheduledAt))
      .limit(200);
    return rows;
  }

  /**
   * SCHEDULED→SENDING transition + audience materialization (dispatch job).
   * CAS-guarded: only one dispatch proceeds; audience rows dedupe on
   * (campaignId, destination).
   */
  async dispatch(storeId: string, campaignId: string, now = new Date()): Promise<{
    readonly dispatched: boolean;
    readonly recipientCount: number;
  }> {
    const claimed = await withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(campaigns)
        .set({ status: CampaignStatus.Sending, sendingStartedAt: now, updatedAt: now })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, CampaignStatus.Scheduled)))
        .returning();
      return updated[0] ?? null;
    });
    if (claimed === null) return { dispatched: false, recipientCount: 0 };

    const recipientCount = await this.materializeAudience(storeId, claimed);
    if (recipientCount === 0) {
      await this.failCampaign(storeId, campaignId, "audience resolved to 0 reachable recipients");
      return { dispatched: true, recipientCount: 0 };
    }
    return { dispatched: true, recipientCount };
  }

  /**
   * Snapshot the audience into campaign_recipients. Deterministic A/B buckets,
   * suppression-skips resolved at SEND time (a recipient unsubscribing after
   * materialization is still honored) — (campaignId, destination) dedupes.
   */
  private async materializeAudience(
    storeId: string,
    campaign: typeof campaigns.$inferSelect,
  ): Promise<number> {
    const hasB = campaign.variantB !== null;
    const splitB = campaign.splitBPercent;
    return withStoreScope(this.db, storeId, async (tx) => {
      const audienceFilter = this.audienceFilter(campaign.audience, campaign.channel);
      const customers = await tx
        .select({
          id: shopifyCustomers.id,
          email: shopifyCustomers.email,
          phone: shopifyCustomers.phone,
        })
        .from(shopifyCustomers)
        .where(and(eq(shopifyCustomers.storeId, storeId), audienceFilter))
        .orderBy(asc(shopifyCustomers.id));

      let insertedTotal = 0;
      const CHUNK = 500;
      for (let i = 0; i < customers.length; i += CHUNK) {
        const chunk = customers.slice(i, i + CHUNK).map((customer) => {
          const destination = (campaign.channel === MessageChannel.Email ? customer.email : customer.phone)!;
          return {
            storeId,
            campaignId: campaign.id,
            customerId: customer.id,
            destination,
            variant: hasB ? assignVariant(campaign.id, customer.id, splitB) : CampaignVariant.A,
            status: CampaignRecipientStatus.Pending,
          };
        });
        if (chunk.length === 0) continue;
        const inserted = await tx
          .insert(campaignRecipients)
          .values(chunk)
          .onConflictDoNothing({ target: [campaignRecipients.campaignId, campaignRecipients.destination] })
          .returning({ id: campaignRecipients.id });
        insertedTotal += inserted.length;
      }
      await tx
        .update(campaigns)
        .set({ recipientCount: insertedTotal, updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id));
      return insertedTotal;
    });
  }

  private audienceFilter(
    audience: CampaignAudienceType,
    channel: MessageChannelType,
  ): ReturnType<typeof sql> {
    const reachable = channel === MessageChannel.Email
      ? sql`${shopifyCustomers.email} IS NOT NULL`
      : sql`${shopifyCustomers.phone} IS NOT NULL`;
    switch (audience) {
      case CampaignAudience.AllCustomers:
        return sql`${reachable}`;
      case CampaignAudience.MarketingOptIn:
        return sql`${reachable} AND ${shopifyCustomers.acceptsMarketing} = true`;
      case CampaignAudience.RepeatCustomers:
        return sql`${reachable} AND ${shopifyCustomers.ordersCount} >= 2`;
    }
  }

  /* ─── stats + winner ───────────────────────────────────────────── */

  async getStats(storeId: string, campaignId: string): Promise<{
    readonly recipients: { readonly pending: number; readonly sent: number; readonly failed: number; readonly skipped: number };
    readonly variants: ReadonlyArray<{
      readonly variant: CampaignVariantType;
      readonly sent: number;
      readonly uniqueOpens: number;
      readonly uniqueClicks: number;
      readonly openRate: number | null;
      readonly clickRate: number | null;
    }>;
    readonly unsubscribes: number;
    readonly recentEvents: ReadonlyArray<{
      readonly id: string;
      readonly kind: (typeof MessageEventKind)[keyof typeof MessageEventKind];
      readonly url: string | null;
      readonly createdAt: Date;
    }>;
  }> {
    const campaign = await this.getCampaign(storeId, campaignId);
    if (campaign === null) throw new CampaignNotFoundError(campaignId);
    return withStoreScope(this.db, storeId, async (tx) => {
      const totals = await tx
        .select({
          status: campaignRecipients.status,
          total: count(),
        })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, campaignId))
        .groupBy(campaignRecipients.status);
      const byStatus = new Map(totals.map((t) => [t.status, t.total]));

      // Separate aggregations (NEVER join recipients↔events for counts: a
      // recipient with N events would inflate row-multiplied totals).
      const variantRows = await tx
        .select({
          variant: campaignRecipients.variant,
          sent: sql<number>`count(*) filter (where ${campaignRecipients.status} = ${CampaignRecipientStatus.Sent})::int`,
        })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, campaignId))
        .groupBy(campaignRecipients.variant);

      const engagementRows = await tx
        .select({
          variant: campaignRecipients.variant,
          uniqueOpens: sql<number>`count(distinct ${messageEvents.recipientId}) filter (where ${messageEvents.kind} = ${MessageEventKind.Opened})::int`,
          uniqueClicks: sql<number>`count(distinct ${messageEvents.recipientId}) filter (where ${messageEvents.kind} = ${MessageEventKind.Clicked})::int`,
        })
        .from(messageEvents)
        .innerJoin(campaignRecipients, eq(messageEvents.recipientId, campaignRecipients.id))
        .where(
          and(
            eq(messageEvents.campaignId, campaignId),
            sql`${messageEvents.kind} IN (${MessageEventKind.Opened}, ${MessageEventKind.Clicked})`,
          ),
        )
        .groupBy(campaignRecipients.variant);

      const unsubRows = await tx
        .select({ total: count() })
        .from(messageEvents)
        .where(and(eq(messageEvents.campaignId, campaignId), eq(messageEvents.kind, MessageEventKind.Unsubscribed)));

      const recent = await tx
        .select({
          id: messageEvents.id,
          kind: messageEvents.kind,
          url: messageEvents.url,
          createdAt: messageEvents.createdAt,
        })
        .from(messageEvents)
        .where(eq(messageEvents.campaignId, campaignId))
        .orderBy(desc(messageEvents.createdAt))
        .limit(15);

      const engagementByVariant = new Map(engagementRows.map((r) => [r.variant, r]));
      const variants = variantRows.map((row) => {
        const variant = row.variant === CampaignVariant.B ? CampaignVariant.B : CampaignVariant.A;
        const engagement = engagementByVariant.get(row.variant);
        const uniqueOpens = engagement?.uniqueOpens ?? 0;
        const uniqueClicks = engagement?.uniqueClicks ?? 0;
        return {
          variant,
          sent: row.sent,
          uniqueOpens,
          uniqueClicks,
          openRate: row.sent > 0 ? Math.round((uniqueOpens / row.sent) * 1000) / 10 : null,
          clickRate: row.sent > 0 ? Math.round((uniqueClicks / row.sent) * 1000) / 10 : null,
        };
      });
      variants.sort((a, b) => a.variant.localeCompare(b.variant));

      return {
        recipients: {
          pending: byStatus.get(CampaignRecipientStatus.Pending) ?? 0,
          sent: byStatus.get(CampaignRecipientStatus.Sent) ?? 0,
          failed: byStatus.get(CampaignRecipientStatus.Failed) ?? 0,
          skipped: byStatus.get(CampaignRecipientStatus.Skipped) ?? 0,
        },
        variants,
        unsubscribes: unsubRows[0]?.total ?? 0,
        recentEvents: recent,
      };
    });
  }

  /**
   * Declare the A/B winner from live stats (operator decision, stored for the
   * record). Allowed once the campaign is SENT and actually had two variants.
   */
  async declareWinner(storeId: string, campaignId: string, variant: string, now = new Date()): Promise<CampaignRow> {
    if (variant !== CampaignVariant.A && variant !== CampaignVariant.B) {
      throw new CampaignStateError("winner must be A or B");
    }
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx.select().from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.storeId, storeId)))
        .limit(1);
      const campaign = rows[0];
      if (campaign === undefined) throw new CampaignNotFoundError(campaignId);
      if (campaign.status !== CampaignStatus.Sent) {
        throw new CampaignStateError("winner can be declared only after the campaign finished sending");
      }
      if (campaign.variantB === null && variant === CampaignVariant.B) {
        throw new CampaignStateError("campaign had no variant B");
      }
      const updated = await tx
        .update(campaigns)
        .set({ winnerVariant: variant, updatedAt: now })
        .where(eq(campaigns.id, campaignId))
        .returning();
      return this.toRow(updated[0]!);
    });
  }

  /** Suppressed destinations for a channel (merchant transparency list). */
  async listSuppressions(
    storeId: string,
    channel: MessageChannelType,
    page: number,
    pageSize: number,
  ): Promise<{ readonly rows: ReadonlyArray<{ id: string; destination: string; reason: string; channel: MessageChannelType; createdAt: Date }>; readonly total: number }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          id: messageSuppressions.id,
          destination: messageSuppressions.destination,
          reason: messageSuppressions.reason,
          channel: messageSuppressions.channel,
          createdAt: messageSuppressions.createdAt,
        })
        .from(messageSuppressions)
        .where(and(eq(messageSuppressions.storeId, storeId), eq(messageSuppressions.channel, channel)))
        .orderBy(desc(messageSuppressions.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const totals = await tx
        .select({ total: count() })
        .from(messageSuppressions)
        .where(and(eq(messageSuppressions.storeId, storeId), eq(messageSuppressions.channel, channel)));
      return { rows, total: totals[0]?.total ?? 0 };
    });
  }

  /** Mark the campaign FAILED with a reason (terminal, operator-visible). */
  async failCampaign(storeId: string, campaignId: string, error: string): Promise<void> {
    await withStoreScope(this.db, storeId, async (tx) => {
      await tx
        .update(campaigns)
        .set({ status: CampaignStatus.Failed, lastError: error, updatedAt: new Date() })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.storeId, storeId)));
    });
  }

  /** SENDING→SENT when every recipient reached a terminal state. */
  async completeCampaign(storeId: string, campaignId: string, now = new Date()): Promise<boolean> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(campaigns)
        .set({ status: CampaignStatus.Sent, sentAt: now, updatedAt: now })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, CampaignStatus.Sending)))
        .returning({ id: campaigns.id });
      return updated.length > 0;
    });
  }

  /** Pending recipients after a keyset cursor (send batches). */
  async nextPendingBatch(
    storeId: string,
    campaignId: string,
    afterRecipientId: string | null,
    limit: number,
  ): Promise<ReadonlyArray<{
    readonly id: string;
    readonly destination: string;
    readonly variantTest: string;
    readonly customerId: string | null;
  }>> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          id: campaignRecipients.id,
          destination: campaignRecipients.destination,
          variantTest: campaignRecipients.variant,
          customerId: campaignRecipients.customerId,
        })
        .from(campaignRecipients)
        .where(
          afterRecipientId !== null
            ? and(
                eq(campaignRecipients.campaignId, campaignId),
                eq(campaignRecipients.status, CampaignRecipientStatus.Pending),
                gt(campaignRecipients.id, afterRecipientId),
              )
            : and(
                eq(campaignRecipients.campaignId, campaignId),
                eq(campaignRecipients.status, CampaignRecipientStatus.Pending),
              ),
        )
        .orderBy(asc(campaignRecipients.id))
        .limit(limit);
      return rows;
    });
  }

  /** Existence probe reusable inside an open scoped transaction. */
  private async existsInTx(tx: ProfitDb, campaignId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    return rows[0] !== undefined;
  }

  private toRow(row: typeof campaigns.$inferSelect): CampaignRow {
    const { storeId: _storeId, ...rest } = row;
    return rest;
  }

  private toTemplateRow(row: typeof messageTemplates.$inferSelect): TemplateRow {
    const { storeId: _storeId, ...rest } = row;
    return rest;
  }
}
