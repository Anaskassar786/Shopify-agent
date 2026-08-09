import {
  and,
  billingEvents,
  campaigns,
  desc,
  eq,
  gte,
  lt,
  messageEvents,
  plans,
  sql,
  stores,
  subscriptions,
  withStoreScope,
  workflowRuns,
  workflowRunSteps,
  aiCallLogs,
  actionExecutions,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  ActionType,
  AiCallStatus,
  BillingEventType,
  BillingInterval,
  ExecutionStatus,
  MessageChannel,
  MessageEventKind,
  PlanCode,
  SubscriptionStatus,
  UsageMeter,
  WorkflowNodeKind,
  WorkflowStepStatus,
} from "@profit/types";
import { evaluateAccess, parseEntitlements, priceForInterval, quotaForMeter, TRIAL_GRACE_DAYS } from "./plans";
import type { AccessDecision, PlanEntitlements } from "./plans";
import type { BillingChargeProvider } from "./ports";
import { AccessOverrideService } from "./access-override.service";

/**
 * BillingService — every subscription-lifecycle read/write lives here (P2
 * Lindsay contract: the router stays a thin HTTP adapter, and the same service
 * is called by trial/reconcile worker jobs).
 *
 * RLS: every knowledge of tenant rows goes through withStoreScope; provider
 * objects are per-store and injected per call (composition roots resolve the
 * OFFLINE token there — token material never enters this module).
 */

export class BillingProviderUnavailableError extends Error {
  constructor() {
    super("billing charge provider unavailable (Shopify credentials not configured)");
    this.name = "BillingProviderUnavailableError";
  }
}

export class BillingConflictError extends Error {
  readonly details: Readonly<Record<string, unknown>>;
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "BillingConflictError";
    this.details = details;
  }
}

export interface EntitlementDenied {
  readonly reason: "SUBSCRIPTION_INACTIVE" | "QUOTA_EXCEEDED";
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PRESERVED_TRIAL_DAYS = 90;

export interface SubscriptionRow {
  readonly id: string;
  readonly storeId: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly shopifyChargeId: string | null;
  readonly billingInterval: BillingInterval | null;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly graceEndsAt: Date | null;
  readonly cancelledAt: Date | null;
}

export interface PlanRow {
  readonly id: string;
  readonly code: PlanCode;
  readonly name: string;
  readonly description: string | null;
  readonly monthlyPriceCents: number;
  readonly yearlyPriceCents: number;
  readonly trialDays: number;
  readonly isActive: boolean;
  readonly entitlements: PlanEntitlements;
}

export interface UsageWindow {
  readonly from: Date;
  readonly to: Date;
}

/** Usage-metering window for quota arithmetic — trial consumption counts toward the trial window. */
export function usageWindowFor(sub: SubscriptionRow | null, installedAt: Date, now: Date): UsageWindow {
  if (sub !== null && sub.currentPeriodStart !== null) {
    return { from: sub.currentPeriodStart, to: sub.currentPeriodEnd ?? now };
  }
  if (sub !== null && sub.status === SubscriptionStatus.Trialing && sub.trialEndsAt !== null) {
    return { from: installedAt, to: sub.trialEndsAt };
  }
  return { from: installedAt, to: now };
}

export function remainingTrialDays(sub: SubscriptionRow | null, now: Date): number {
  // CHARGE_PENDING keeps trialEndsAt by construction (the merchant is on
  // Shopify's decision page mid-trial) — activation must honor those days
  // exactly like the TRIALING state does.
  if (sub === null) return 0;
  if (sub.status !== SubscriptionStatus.Trialing && sub.status !== SubscriptionStatus.ChargePending) return 0;
  if (sub.trialEndsAt === null) return 0;
  return Math.min(MAX_PRESERVED_TRIAL_DAYS, Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / DAY_MS)));
}

export interface MeterUsage {
  readonly meter: UsageMeter;
  readonly used: number;
  readonly limit: number;
  readonly percentUsed: number | null; // null when the plan does not cap the meter
}

export class BillingService {
  private readonly accessOverrides: AccessOverrideService;

  constructor(private readonly db: ProfitDb) {
    this.accessOverrides = new AccessOverrideService(db);
  }

  /** Current subscription + plan + parsed entitlements, or null when the store never onboarded billing. */
  async getSubscriptionState(storeId: string): Promise<{
    subscription: SubscriptionRow | null;
    plan: PlanRow | null;
  }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({ subscription: subscriptions, plan: plans })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.storeId, storeId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return { subscription: null, plan: null } as const;
      const { createdAt: _c1, updatedAt: _c2, ...subscription } = row.subscription;
      const { createdAt: _c3, updatedAt: _c4, isActive, ...planRest } = row.plan;
      return {
        subscription: subscription as SubscriptionRow,
        plan: { ...planRest, isActive, entitlements: parseEntitlements(row.plan.entitlements) },
      } as const;
    });
  }

  /**
   * Effective access decision for the revenue-action gate (single source).
   * M6: a live support-granted access override bypasses ONLY the status gate
   * (quota checks below remain fully enforced from the store's plan).
   */
  async evaluateStoreAccess(storeId: string, now = new Date()): Promise<AccessDecision & { status: SubscriptionStatus | null }> {
    const { subscription } = await this.getSubscriptionState(storeId);
    if (subscription === null) {
      return { revenueActionsAllowed: false, blockedReason: "Start your free trial to unlock revenue actions", status: null };
    }
    const decision = evaluateAccess(subscription, now);
    if (decision.revenueActionsAllowed) return { ...decision, status: subscription.status };
    const override = await this.accessOverrides.findActiveForStore(storeId, now);
    if (override !== null) {
      return { revenueActionsAllowed: true, blockedReason: null, status: subscription.status };
    }
    return { ...decision, status: subscription.status };
  }

  /**
   * M6 admin write action: extend the trial window. TRIALING adds days on top
   * of the current horizon; TRIAL_EXPIRED reactivates into a fresh window.
   * Ledger + subscription update commit in ONE scoped transaction.
   */
  async extendTrial(
    storeId: string,
    additionalDays: number,
    now = new Date(),
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<SubscriptionRow> {
    if (!Number.isInteger(additionalDays) || additionalDays < 1 || additionalDays > 90) {
      throw new BillingConflictError("trial extension must be 1..90 days", { additionalDays });
    }
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.storeId, storeId))
        .limit(1);
      const existing = rows[0];
      if (existing === undefined) {
        throw new BillingConflictError("no subscription to extend — the store never started a trial");
      }
      const fromStatus = existing.status;
      let newTrialEndsAt: Date;
      if (existing.status === SubscriptionStatus.Trialing) {
        const base = existing.trialEndsAt !== null && existing.trialEndsAt.getTime() > now.getTime()
          ? existing.trialEndsAt.getTime()
          : now.getTime();
        newTrialEndsAt = new Date(base + additionalDays * DAY_MS);
      } else if (existing.status === SubscriptionStatus.TrialExpired) {
        newTrialEndsAt = new Date(now.getTime() + additionalDays * DAY_MS);
      } else {
        throw new BillingConflictError(
          `trial extension applies to TRIALING/TRIAL_EXPIRED subscriptions (this one is ${existing.status})`,
          { status: existing.status },
        );
      }
      const updated = await tx
        .update(subscriptions)
        .set({
          status: SubscriptionStatus.Trialing,
          trialEndsAt: newTrialEndsAt,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, existing.id))
        .returning();
      const row = updated[0];
      if (row === undefined) throw new BillingConflictError("subscription update returned no row");
      await this.recordEvent(tx, {
        storeId,
        type: BillingEventType.TrialExtended,
        fromStatus,
        toStatus: SubscriptionStatus.Trialing,
        metadata: {
          additionalDays,
          trialEndsAt: newTrialEndsAt.toISOString(),
          reactivated: fromStatus === SubscriptionStatus.TrialExpired,
          ...metadata,
        },
      });
      const { createdAt: _c1, updatedAt: _c2, ...narrow } = row;
      return narrow as SubscriptionRow;
    });
  }

  /**
   * Start the 3-day trial (P7 install flow). Idempotent — a store with any
   * existing subscription row gets it back unchanged (double-clicks and
   * re-opened wizards are free).
   */
  async startTrial(storeId: string, defaultPlanCode: PlanCode, now = new Date()): Promise<{
    subscription: SubscriptionRow;
    created: boolean;
  }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const existing = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.storeId, storeId))
        .limit(1);
      if (existing[0] !== undefined) {
        const { createdAt: _c1, updatedAt: _c2, ...row } = existing[0];
        return { subscription: row as SubscriptionRow, created: false };
      }
      const planRows = await tx
        .select()
        .from(plans)
        .where(and(eq(plans.code, defaultPlanCode), eq(plans.isActive, true)))
        .limit(1);
      const plan = planRows[0];
      if (plan === undefined) throw new BillingConflictError(`default plan not seeded: ${defaultPlanCode}`);
      const trialEndsAt = new Date(now.getTime() + plan.trialDays * DAY_MS);
      const inserted = await tx
        .insert(subscriptions)
        .values({
          storeId,
          planId: plan.id,
          status: SubscriptionStatus.Trialing,
          trialEndsAt,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new BillingConflictError("subscription insert returned no row");
      await this.recordEvent(tx, {
        storeId,
        type: BillingEventType.TrialStarted,
        planCode: plan.code,
        toStatus: SubscriptionStatus.Trialing,
        metadata: { trialEndsAt: trialEndsAt.toISOString(), trialDays: plan.trialDays },
      });
      const { createdAt: _c3, updatedAt: _c4, ...narrow } = row;
      return { subscription: narrow as SubscriptionRow, created: true };
    });
  }

  /**
   * Create a Shopify recurring charge (P2 subscribe). The subscription row
   * moves to CHARGE_PENDING with the charge id; acceptance itself is settled
   * ONLY by resolveChargeOutcome reading the live API after Shopify's redirect.
   */
  async subscribe(input: {
    storeId: string;
    planCode: PlanCode;
    interval: BillingInterval;
    provider: BillingChargeProvider | null;
    returnUrl: string;
    test: boolean;
    now?: Date;
  }): Promise<{ confirmationUrl: string; chargeId: string }> {
    if (input.provider === null) throw new BillingProviderUnavailableError();
    const now = input.now ?? new Date();
    const state = await this.getSubscriptionState(input.storeId);
    if (state.subscription !== null && state.subscription.status === SubscriptionStatus.Active) {
      throw new BillingConflictError("this store already has an active paid charge");
    }
    const planRows = await withStoreScope(this.db, input.storeId, async (tx) =>
      tx.select().from(plans).where(and(eq(plans.code, input.planCode), eq(plans.isActive, true))).limit(1),
    );
    const plan = planRows[0];
    if (plan === undefined) throw new BillingConflictError(`plan not available: ${input.planCode}`);

    const preservedTrialDays = remainingTrialDays(state.subscription, now);
    const charge = await input.provider.createRecurringCharge({
      planCode: plan.code as PlanCode,
      planName: `PROFIT TOOL AI — ${plan.name} (${input.interval === "MONTHLY" ? "monthly" : "yearly"})`,
      amountCents: priceForInterval(plan, input.interval),
      interval: input.interval,
      returnUrl: input.returnUrl,
      trialDays: preservedTrialDays,
      test: input.test,
    });

    await withStoreScope(this.db, input.storeId, async (tx) => {
      const trialEndsAt = state.subscription?.trialEndsAt ?? new Date(now.getTime() + plan.trialDays * DAY_MS);
      if (state.subscription === null) {
        await tx.insert(subscriptions).values({
          storeId: input.storeId,
          planId: plan.id,
          status: SubscriptionStatus.ChargePending,
          shopifyChargeId: charge.chargeId,
          billingInterval: input.interval,
          trialEndsAt,
          graceEndsAt: new Date(trialEndsAt.getTime() + TRIAL_GRACE_DAYS * DAY_MS),
        });
      } else {
        await tx
          .update(subscriptions)
          .set({
            planId: plan.id,
            status: SubscriptionStatus.ChargePending,
            shopifyChargeId: charge.chargeId,
            billingInterval: input.interval,
            graceEndsAt: new Date(trialEndsAt.getTime() + TRIAL_GRACE_DAYS * DAY_MS),
            updatedAt: now,
          })
          .where(eq(subscriptions.id, state.subscription.id));
      }
      await this.recordEvent(tx, {
        storeId: input.storeId,
        type: BillingEventType.ChargeCreated,
        planCode: plan.code as PlanCode,
        chargeId: charge.chargeId,
        amountCents: priceForInterval(plan, input.interval),
        interval: input.interval,
        fromStatus: state.subscription?.status ?? null,
        toStatus: SubscriptionStatus.ChargePending,
        metadata: { preservedTrialDays },
      });
    });

    return { confirmationUrl: charge.confirmationUrl, chargeId: charge.chargeId };
  }

  /**
   * Settle a pending charge decision against the live API — the ONLY path to
   * ACTIVE (used by the Shopify callback handler AND the daily reconcile
   * sweep, so webhooks are never required for correctness).
   */
  async resolveChargeOutcome(input: {
    storeId: string;
    provider: BillingChargeProvider | null;
    source: "CALLBACK" | "RECONCILE";
    now?: Date;
  }): Promise<
    | { readonly outcome: "ACTIVATED"; chargeId: string; interval: BillingInterval }
    | { readonly outcome: "DECLINED"; chargeId: string | null }
    | { readonly outcome: "PENDING"; chargeId: string | null }
    | { readonly outcome: "NO_PENDING" }
  > {
    const state = await this.getSubscriptionState(input.storeId);
    const sub = state.subscription;
    if (sub === null || sub.status !== SubscriptionStatus.ChargePending) return { outcome: "NO_PENDING" } as const;
    if (input.provider === null) throw new BillingProviderUnavailableError();
    const now = input.now ?? new Date();
    const live = await input.provider.fetchLiveSubscriptions();
    const match = sub.shopifyChargeId === null ? undefined : live.find((s) => s.chargeId === sub.shopifyChargeId);

    if (match !== undefined && (match.status === "ACTIVE" || match.status === "ACCEPTED")) {
      const interval = sub.billingInterval ?? BillingInterval.Monthly;
      const cycleDays = interval === "MONTHLY" ? 30 : 365;
      const preserved = remainingTrialDays(sub, now);
      const periodEnd = new Date(now.getTime() + (preserved + cycleDays) * DAY_MS);
      await withStoreScope(this.db, input.storeId, async (tx) => {
        await tx
          .update(subscriptions)
          .set({
            status: SubscriptionStatus.Active,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            cancelledAt: null,
            updatedAt: now,
          })
          .where(eq(subscriptions.id, sub.id));
        await this.recordEvent(tx, {
          storeId: input.storeId,
          type: BillingEventType.ChargeAccepted,
          planCode: state.plan?.code,
          chargeId: match.chargeId,
          interval,
          fromStatus: sub.status,
          toStatus: SubscriptionStatus.Active,
          metadata: {
            source: input.source,
            preservedTrialDays: preserved,
            periodEnd: periodEnd.toISOString(),
          },
        });
      });
      return { outcome: "ACTIVATED", chargeId: match.chargeId, interval } as const;
    }

    if (
      match === undefined ||
      match.status === "DECLINED" ||
      match.status === "CANCELLED" ||
      match.status === "EXPIRED"
    ) {
      // Fall back to the safest pre-charge state (trial if still running).
      const trialAlive = sub.trialEndsAt !== null && sub.trialEndsAt.getTime() > now.getTime();
      const fallback = trialAlive ? SubscriptionStatus.Trialing : SubscriptionStatus.TrialExpired;
      await withStoreScope(this.db, input.storeId, async (tx) => {
        await tx
          .update(subscriptions)
          .set({ status: fallback, updatedAt: now })
          .where(eq(subscriptions.id, sub.id));
        await this.recordEvent(tx, {
          storeId: input.storeId,
          type: BillingEventType.ChargeDeclined,
          chargeId: sub.shopifyChargeId,
          fromStatus: sub.status,
          toStatus: fallback,
          metadata: { source: input.source, liveStatus: match?.status ?? "missing" },
        });
      });
      return { outcome: "DECLINED", chargeId: sub.shopifyChargeId } as const;
    }

    return { outcome: "PENDING", chargeId: match.chargeId } as const;
  }

  /**
   * Stale decision screen (pending past the decision limit): treat as declined
   * WITHOUT a provider call — the charge simply never resolved.
   */
  async settleStalePending(storeId: string, now = new Date()): Promise<boolean> {
    const state = await this.getSubscriptionState(storeId);
    const sub = state.subscription;
    if (sub === null || sub.status !== SubscriptionStatus.ChargePending) return false;
    const trialAlive = sub.trialEndsAt !== null && sub.trialEndsAt.getTime() > now.getTime();
    const fallback = trialAlive ? SubscriptionStatus.Trialing : SubscriptionStatus.TrialExpired;
    return this.transition({
      storeId,
      to: fallback,
      eventType: BillingEventType.ChargeDeclined,
      metadata: { reason: "stale_decision_screen", chargeId: sub.shopifyChargeId },
      now,
    });
  }

  /** Cancel the live charge; pre-paid time stays usable until currentPeriodEnd. */
  async cancel(input: {
    storeId: string;
    provider: BillingChargeProvider | null;
    now?: Date;
  }): Promise<{ cancelled: true }> {
    const state = await this.getSubscriptionState(input.storeId);
    const sub = state.subscription;
    if (sub === null || sub.shopifyChargeId === null) {
      throw new BillingConflictError("no Shopify charge exists for this subscription");
    }
    if (
      sub.status !== SubscriptionStatus.Active &&
      sub.status !== SubscriptionStatus.ChargePending &&
      sub.status !== SubscriptionStatus.PastDue
    ) {
      throw new BillingConflictError(`cancellation is not valid in status ${sub.status}`);
    }
    if (input.provider === null) throw new BillingProviderUnavailableError();
    const now = input.now ?? new Date();
    await input.provider.cancelRecurringCharge(sub.shopifyChargeId);
    await withStoreScope(this.db, input.storeId, async (tx) => {
      await tx
        .update(subscriptions)
        .set({ status: SubscriptionStatus.Cancelled, cancelledAt: now, updatedAt: now })
        .where(eq(subscriptions.id, sub.id));
      await this.recordEvent(tx, {
        storeId: input.storeId,
        type: BillingEventType.ChargeCancelled,
        chargeId: sub.shopifyChargeId,
        interval: sub.billingInterval,
        fromStatus: sub.status,
        toStatus: SubscriptionStatus.Cancelled,
        metadata: { honoredUntil: sub.currentPeriodEnd?.toISOString() ?? null },
      });
    });
    return { cancelled: true } as const;
  }

  /** Live usage count for one meter inside a window (enforcement must never trust rollup lag). */
  private async countUsage(tx: ProfitDb, storeId: string, meter: UsageMeter, window: UsageWindow): Promise<number> {
    switch (meter) {
      case UsageMeter.AiCalls: {
        const rows = await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(aiCallLogs)
          .where(
            and(
              eq(aiCallLogs.storeId, storeId),
              eq(aiCallLogs.status, AiCallStatus.Succeeded),
              gte(aiCallLogs.createdAt, window.from),
              lt(aiCallLogs.createdAt, window.to),
            ),
          );
        return rows[0]?.used ?? 0;
      }
      case UsageMeter.EmailsSent: {
        // Sources (disjoint ledgers, summed): M4 recovery-email tool
        // checkpoints + M6 campaign SENT events + M6 workflow SEND_EMAIL steps.
        const m4 = await tx
          .select({
            used: sql<number>`coalesce(sum(case when jsonb_typeof(${actionExecutions.toolRef} -> 'sentTo') = 'array' then jsonb_array_length(${actionExecutions.toolRef} -> 'sentTo') else 0 end), 0)::int`,
          })
          .from(actionExecutions)
          .where(
            and(
              eq(actionExecutions.storeId, storeId),
              eq(actionExecutions.actionType, ActionType.SendRecoveryEmail),
              gte(actionExecutions.createdAt, window.from),
              lt(actionExecutions.createdAt, window.to),
            ),
          );
        const campaignRows = await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(messageEvents)
          .innerJoin(campaigns, eq(messageEvents.campaignId, campaigns.id))
          .where(
            and(
              eq(messageEvents.storeId, storeId),
              eq(messageEvents.kind, MessageEventKind.Sent),
              eq(campaigns.channel, MessageChannel.Email),
              gte(messageEvents.createdAt, window.from),
              lt(messageEvents.createdAt, window.to),
            ),
          );
        const workflowRows = await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(workflowRunSteps)
          .where(
            and(
              eq(workflowRunSteps.storeId, storeId),
              eq(workflowRunSteps.nodeKind, WorkflowNodeKind.SendEmail),
              eq(workflowRunSteps.status, WorkflowStepStatus.Completed),
              gte(workflowRunSteps.completedAt, window.from),
              lt(workflowRunSteps.completedAt, window.to),
            ),
          );
        return (m4[0]?.used ?? 0) + (campaignRows[0]?.used ?? 0) + (workflowRows[0]?.used ?? 0);
      }
      case UsageMeter.SmsSent: {
        const campaignRows = await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(messageEvents)
          .innerJoin(campaigns, eq(messageEvents.campaignId, campaigns.id))
          .where(
            and(
              eq(messageEvents.storeId, storeId),
              eq(messageEvents.kind, MessageEventKind.Sent),
              eq(campaigns.channel, MessageChannel.Sms),
              gte(messageEvents.createdAt, window.from),
              lt(messageEvents.createdAt, window.to),
            ),
          );
        const workflowRows = await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(workflowRunSteps)
          .where(
            and(
              eq(workflowRunSteps.storeId, storeId),
              eq(workflowRunSteps.nodeKind, WorkflowNodeKind.SendSms),
              eq(workflowRunSteps.status, WorkflowStepStatus.Completed),
              gte(workflowRunSteps.completedAt, window.from),
              lt(workflowRunSteps.completedAt, window.to),
            ),
          );
        return (campaignRows[0]?.used ?? 0) + (workflowRows[0]?.used ?? 0);
      }
      case UsageMeter.AutomationRuns: {
        const rows = await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(actionExecutions)
          .where(
            and(
              eq(actionExecutions.storeId, storeId),
              sql`${actionExecutions.status} <> ${ExecutionStatus.Pending}`,
              gte(actionExecutions.startedAt, window.from),
              lt(actionExecutions.startedAt, window.to),
            ),
          );
        // M6 workflow runs meter by run start (one run = one unit).
        const workflowRows = await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.storeId, storeId),
              gte(workflowRuns.createdAt, window.from),
              lt(workflowRuns.createdAt, window.to),
            ),
          );
        return (rows[0]?.used ?? 0) + (workflowRows[0]?.used ?? 0);
      }
    }
  }

  async usageSummary(storeId: string, now = new Date()): Promise<{
    window: UsageWindow;
    meters: readonly MeterUsage[];
    entitlements: PlanEntitlements | null;
    status: SubscriptionStatus | null;
  }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const storeRows = await tx
        .select({ installedAt: stores.installedAt })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const installedAt = storeRows[0]?.installedAt ?? now;
      const subRows = await tx
        .select({ subscription: subscriptions, plan: plans })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.storeId, storeId))
        .limit(1);
      const row = subRows[0];
      const { createdAt: _c1, updatedAt: _c2, ...sub } = row?.subscription ?? {};
      const subscription = row === undefined ? null : (sub as SubscriptionRow);
      const entitlements = row === undefined ? null : parseEntitlements(row.plan.entitlements);
      const window = usageWindowFor(subscription, installedAt, now);
      const meters: MeterUsage[] = [];
      for (const meter of Object.values(UsageMeter)) {
        const used = await this.countUsage(tx, storeId, meter, window);
        const limit = entitlements === null ? 0 : quotaForMeter(entitlements, meter);
        meters.push({
          meter,
          used,
          limit,
          percentUsed: limit <= 0 ? null : Math.min(100, Math.round((used / limit) * 100)),
        });
      }
      return { window, meters, entitlements, status: subscription?.status ?? null };
    });
  }

  /**
   * The quota gate (P2 subscription validation, P11 quotas). Returns null when
   * allowed; otherwise a typed refusal the API maps to UPGRADE_REQUIRED or
   * QUOTA_EXCEEDED — worker jobs map it to a skip + notification.
   */
  async checkEntitlement(
    storeId: string,
    meter: UsageMeter,
    additionalUnits = 1,
    now = new Date(),
  ): Promise<EntitlementDenied | null> {
    const state = await this.getSubscriptionState(storeId);
    const access = evaluateAccess(
      state.subscription ?? {
        status: SubscriptionStatus.TrialExpired,
        trialEndsAt: null,
        currentPeriodEnd: null,
        graceEndsAt: null,
      },
      now,
    );
    if (!access.revenueActionsAllowed) {
      // M6: a live support override bypasses the status gate only — plan
      // quota checks below still apply in full.
      const override = await this.accessOverrides.findActiveForStore(storeId, now);
      if (override === null) {
        return {
          reason: "SUBSCRIPTION_INACTIVE",
          message: access.blockedReason ?? "Subscription is not active",
          details: { status: state.subscription?.status ?? null },
        };
      }
    }
    if (state.plan === null || state.subscription === null) {
      return {
        reason: "SUBSCRIPTION_INACTIVE",
        message: "Start your free trial to unlock revenue actions",
        details: { status: null },
      };
    }
    const storeRows = await withStoreScope(this.db, storeId, async (tx) =>
      tx.select({ installedAt: stores.installedAt }).from(stores).where(eq(stores.id, storeId)).limit(1),
    );
    const window = usageWindowFor(state.subscription, storeRows[0]?.installedAt ?? now, now);
    const limit = quotaForMeter(state.plan.entitlements, meter);
    const used = await withStoreScope(this.db, storeId, async (tx) =>
      this.countUsage(tx, storeId, meter, window),
    );
    if (used + additionalUnits > limit) {
      return {
        reason: "QUOTA_EXCEEDED",
        message: `Your ${state.plan.name} plan's ${meter.toLowerCase().replaceAll("_", " ")} limit (${limit}) is reached for this period`,
        details: { meter, limit, used, periodStart: window.from.toISOString(), periodEnd: window.to.toISOString() },
      };
    }
    return null;
  }

  /** Active plan catalog + the store's current plan id (comparison UI + admin audits). */
  async listPlans(storeId: string): Promise<{
    currentPlanId: string | null;
    plans: readonly PlanRow[];
  }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(plans)
        .where(eq(plans.isActive, true))
        .orderBy(plans.monthlyPriceCents);
      const subs = await tx
        .select({ planId: subscriptions.planId })
        .from(subscriptions)
        .where(eq(subscriptions.storeId, storeId))
        .limit(1);
      return {
        currentPlanId: subs[0]?.planId ?? null,
        plans: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description,
          monthlyPriceCents: row.monthlyPriceCents,
          yearlyPriceCents: row.yearlyPriceCents,
          trialDays: row.trialDays,
          isActive: row.isActive,
          entitlements: parseEntitlements(row.entitlements),
        })),
      };
    });
  }

  /** Billing history feed (merchant UI + admin): newest first. */
  async history(storeId: string, limit = 50): Promise<readonly (typeof billingEvents.$inferSelect)[]> {
    return withStoreScope(this.db, storeId, async (tx) =>
      tx
        .select()
        .from(billingEvents)
        .where(eq(billingEvents.storeId, storeId))
        .orderBy(desc(billingEvents.createdAt))
        .limit(limit),
    );
  }

  /**
   * Transition helper used by the lifecycle/reconcile jobs (same-tx event
   * recording so ledger and row can never disagree).
   */
  async transition(input: {
    storeId: string;
    to: SubscriptionStatus;
    eventType: BillingEventType;
    extra?: Partial<{
      trialEndsAt: Date | null;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
      graceEndsAt: Date | null;
      cancelledAt: Date | null;
    }>;
    metadata?: Readonly<Record<string, unknown>>;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    return withStoreScope(this.db, input.storeId, async (tx) => {
      const rows = await tx
        .select({ id: subscriptions.id, status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.storeId, input.storeId))
        .limit(1);
      const current = rows[0];
      if (current === undefined || current.status === input.to) return false;
      await tx
        .update(subscriptions)
        .set({
          status: input.to,
          ...(input.extra ?? {}),
          updatedAt: now,
        })
        .where(eq(subscriptions.id, current.id));
      await this.recordEvent(tx, {
        storeId: input.storeId,
        type: input.eventType,
        fromStatus: current.status,
        toStatus: input.to,
        metadata: input.metadata ?? {},
      });
      return true;
    });
  }

  protected async recordEvent(
    tx: ProfitDb,
    event: {
      storeId: string;
      type: BillingEventType;
      planCode?: PlanCode | undefined;
      chargeId?: string | null | undefined;
      amountCents?: number | undefined;
      interval?: BillingInterval | null | undefined;
      fromStatus?: string | null | undefined;
      toStatus?: string | null | undefined;
      metadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await tx.insert(billingEvents).values({
      storeId: event.storeId,
      type: event.type,
      planCode: event.planCode,
      chargeId: event.chargeId ?? null,
      amountCents: event.amountCents ?? 0,
      interval: event.interval ?? null,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      metadata: event.metadata ?? {},
    });
  }
}
