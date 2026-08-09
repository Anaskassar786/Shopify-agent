import {
  and,
  billingEvents,
  eq,
  inArray,
  isNotNull,
  lt,
  plans,
  recommendations,
  recommendationOutcomes,
  sql,
  stores,
  subscriptions,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  BillingEventType,
  RecommendationStatus,
  StoreStatus,
  SubscriptionStatus,
} from "@profit/types";
import { BillingService } from "./billing.service";
import { TRIAL_GRACE_DAYS } from "./plans";
import type { TrialMailer } from "./ports";
import { renderTrialNudge } from "./trial-templates";

/**
 * TrialLifecycleService (P7/P11): the daily-conversion worker engine.
 *  - D1/D2/D3 merchant emails with REAL engine numbers (deduped per store+day
 *    via billing_events TRIAL_NUDGE_SENT rows — the ledger is the outbox).
 *  - TRIALING → TRIAL_EXPIRED at trialEndsAt (grace window opens).
 *  - TRIAL_EXPIRED / PAST_DUE → SUSPENDED once graceEndsAt passes.
 *
 * Provider-free: it never calls Shopify (acceptance is owned by
 * resolveChargeOutcome + reconcile). Returns everything it did so the worker
 * handler can publish notifications/engagement without duplicating decisions.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialTickReport {
  readonly nudgesSent: readonly { storeId: string; day: number; to: string }[];
  readonly nudgesSkippedNoMailer: number;
  readonly trialsExpired: readonly string[];
  readonly suspended: readonly string[];
}

export class TrialLifecycleService {
  constructor(
    private readonly db: ProfitDb,
    private readonly billing: BillingService,
    private readonly mailer: TrialMailer | null,
    private readonly appUrl: string,
  ) {}

  async tick(now = new Date()): Promise<TrialTickReport> {
    const nudgesSent: { storeId: string; day: number; to: string }[] = [];
    const trialsExpired: string[] = [];
    const suspended: string[] = [];
    let nudgesSkippedNoMailer = 0;

    // ── 1. Trial journey nudges + expiry ──────────────────────────────────
    const trialing = await this.db
      .select({ subscription: subscriptions, plan: plans, store: stores })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .innerJoin(stores, and(eq(stores.id, subscriptions.storeId), eq(stores.status, StoreStatus.Active)))
      .where(eq(subscriptions.status, SubscriptionStatus.Trialing));

    for (const { subscription: sub, plan, store } of trialing) {
      if (sub.trialEndsAt === null) continue;
      const msLeft = sub.trialEndsAt.getTime() - now.getTime();
      if (msLeft <= 0) {
        const graceEndsAt = new Date(now.getTime() + TRIAL_GRACE_DAYS * DAY_MS);
        const flipped = await this.billing.transition({
          storeId: sub.storeId,
          to: SubscriptionStatus.TrialExpired,
          eventType: BillingEventType.TrialExpired,
          extra: { graceEndsAt },
          metadata: { trialEndsAt: sub.trialEndsAt.toISOString(), graceEndsAt: graceEndsAt.toISOString() },
          now,
        });
        if (flipped) trialsExpired.push(sub.storeId);
        continue;
      }

      const daysRemaining = Math.ceil(msLeft / DAY_MS);
      const nudgeDay = plan.trialDays - daysRemaining + 1; // day 1 emits on the first full day
      if (nudgeDay < 1 || nudgeDay > plan.trialDays) continue;
      const elapsedMs = now.getTime() - store.installedAt.getTime();
      if (nudgeDay > 1 && elapsedMs < (nudgeDay - 1) * DAY_MS) continue; // D2/D3 keep their day
      if (nudgeDay === 1 && elapsedMs < DAY_MS / 2) continue; // D1 waits half a day for real data

      const alreadySent = await this.db
        .select({ id: billingEvents.id })
        .from(billingEvents)
        .where(
          and(
            eq(billingEvents.storeId, sub.storeId),
            eq(billingEvents.type, BillingEventType.TrialNudgeSent),
            sql`${billingEvents.metadata} ->> 'day' = ${String(nudgeDay)}`,
          ),
        )
        .limit(1);
      if (alreadySent[0] !== undefined) continue;

      if (this.mailer === null || store.email === null) {
        nudgesSkippedNoMailer += 1;
        continue;
      }

      const facts = await this.loadNudgeFacts(sub.storeId, store.name, daysRemaining, nudgeDay);
      await this.mailer.send({
        to: store.email,
        shopName: store.name,
        ...renderTrialNudge(facts),
      });
      await this.db.insert(billingEvents).values({
        storeId: sub.storeId,
        type: BillingEventType.TrialNudgeSent,
        metadata: { day: nudgeDay, to: store.email, ...factsDigest(facts) },
      });
      nudgesSent.push({ storeId: sub.storeId, day: nudgeDay, to: store.email });
    }

    // ── 2. Grace exhaustion → suspension ──────────────────────────────────
    const eligibleForSuspension = await this.db
      .select({ storeId: subscriptions.storeId })
      .from(subscriptions)
      .innerJoin(stores, and(eq(stores.id, subscriptions.storeId), eq(stores.status, StoreStatus.Active)))
      .where(
        and(
          inArray(subscriptions.status, [
            SubscriptionStatus.TrialExpired,
            SubscriptionStatus.PastDue,
          ]),
          isNotNull(subscriptions.graceEndsAt),
          lt(subscriptions.graceEndsAt, now),
        ),
      );
    for (const row of eligibleForSuspension) {
      const flipped = await this.billing.transition({
        storeId: row.storeId,
        to: SubscriptionStatus.Suspended,
        eventType: BillingEventType.SubscriptionSuspended,
        metadata: { reason: "grace_elapsed" },
        now,
      });
      if (flipped) suspended.push(row.storeId);
    }

    return { nudgesSent, nudgesSkippedNoMailer, trialsExpired, suspended };
  }

  private async loadNudgeFacts(
    storeId: string,
    shopName: string,
    daysRemaining: number,
    day: number,
  ): Promise<Parameters<typeof renderTrialNudge>[0]> {
    const openStatuses: RecommendationStatus[] = [
      RecommendationStatus.PendingApproval,
      RecommendationStatus.Approved,
      RecommendationStatus.Scheduled,
    ];
    const openRows = await this.db
      .select({
        open: sql<number>`count(*)::int`,
        estimatedCents: sql<number>`coalesce(sum(${recommendations.estimatedRevenueCents}), 0)::bigint`,
      })
      .from(recommendations)
      .where(and(eq(recommendations.storeId, storeId), inArray(recommendations.status, openStatuses)));
    const attributedRows = await this.db
      .select({
        cents: sql<number>`coalesce(sum(${recommendationOutcomes.attributedRevenueCents}), 0)::bigint`,
      })
      .from(recommendationOutcomes)
      .where(eq(recommendationOutcomes.storeId, storeId));
    return {
      shopName,
      day: Math.min(3, Math.max(1, Math.round(day))) as 1 | 2 | 3,
      openRecommendations: openRows[0]?.open ?? 0,
      openEstimatedRevenueCents: openRows[0]?.estimatedCents ?? 0,
      attributedRevenueCents: attributedRows[0]?.cents ?? 0,
      daysRemaining,
      appUrl: this.appUrl,
    };
  }
}

function factsDigest(facts: { openRecommendations: number; openEstimatedRevenueCents: number }): Record<string, unknown> {
  return {
    openRecommendations: facts.openRecommendations,
    openEstimatedRevenueCents: facts.openEstimatedRevenueCents,
  };
}
