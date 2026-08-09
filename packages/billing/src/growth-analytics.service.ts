import {
  aiCallLogs,
  aiRuns,
  and,
  backgroundJobs,
  desc,
  eq,
  execRaw,
  failedJobs,
  gte,
  inArray,
  plans,
  sql,
  stores,
  subscriptions,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { AiCallStatus, JobStatus, SubscriptionStatus } from "@profit/types";
import { EngagementService } from "./engagement.service";

/**
 * GrowthAnalyticsService (P11 owner dashboard + P12 admin panel v1):
 * cross-tenant reads that ONLY the platform-admin surface may call. Runs as
 * the owner role by design — this is the documented, audited exception to
 * tenant scoping (every admin API request is audit-logged; see the admin
 * router). Figures are modeled estimates and labelled as such at the edge.
 */

export interface OwnerDashboard {
  readonly merchants: { total: number; active: number; uninstalled: number };
  readonly subscriptions: {
    trialing: number;
    active: number;
    chargePending: number;
    trialExpired: number;
    cancelled: number;
    suspended: number;
  };
  /** Modeled monthly/annual recurring revenue in cents from ACTIVE subs (labeled estimate). */
  readonly modeledMrrCents: number;
  readonly modeledArrCents: number;
  readonly ai: {
    runsLast7d: number;
    costMicrosLast7d: number;
    tokensLast7d: number;
  };
  readonly system: {
    jobsRunning: number;
    jobsPending: number;
    jobsFailed: number;
    deadJobs: number;
  };
}

export interface MerchantRow {
  readonly storeId: string;
  readonly shopDomain: string;
  readonly name: string;
  readonly installedAt: Date;
  readonly planCode: string | null;
  readonly subscriptionStatus: string | null;
  readonly trialEndsAt: Date | null;
  readonly attributedRevenueCents: number;
  readonly aiCostMicrosLast30d: number;
  readonly lastActivityAt: Date | null;
}

/** execRaw returns driver-native values: timestamps may be strings on some drivers. */
type RawMerchantRow = Omit<MerchantRow, "installedAt" | "trialEndsAt" | "lastActivityAt"> & {
  installedAt: string | Date;
  trialEndsAt: string | Date | null;
  lastActivityAt: string | Date | null;
};

function asDateOrNull(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export class GrowthAnalyticsService {
  constructor(private readonly db: ProfitDb) {}

  async ownerDashboard(now = new Date()): Promise<OwnerDashboard> {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [merchantCounts, subCounts, mrr, aiUsage, system] = await Promise.all([
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where ${stores.status} = 'ACTIVE')::int`,
          uninstalled: sql<number>`count(*) filter (where ${stores.status} = 'UNINSTALLED')::int`,
        })
        .from(stores),
      this.db
        .select({
          trialing: sql<number>`count(*) filter (where ${subscriptions.status} = ${SubscriptionStatus.Trialing})::int`,
          active: sql<number>`count(*) filter (where ${subscriptions.status} = ${SubscriptionStatus.Active})::int`,
          chargePending: sql<number>`count(*) filter (where ${subscriptions.status} = ${SubscriptionStatus.ChargePending})::int`,
          trialExpired: sql<number>`count(*) filter (where ${subscriptions.status} = ${SubscriptionStatus.TrialExpired})::int`,
          cancelled: sql<number>`count(*) filter (where ${subscriptions.status} = ${SubscriptionStatus.Cancelled})::int`,
          suspended: sql<number>`count(*) filter (where ${subscriptions.status} = ${SubscriptionStatus.Suspended})::int`,
        })
        .from(subscriptions),
      this.db
        .select({
          mrrCents: sql<number>`coalesce(sum(case
            when ${subscriptions.billingInterval} = 'YEARLY' then ${plans.yearlyPriceCents} / 12
            else ${plans.monthlyPriceCents} end), 0)::bigint`,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.status, SubscriptionStatus.Active)),
      this.db
        .select({
          runs: sql<number>`(select count(*)::int from ${aiRuns} where ${aiRuns.createdAt} >= ${sevenDaysAgo})`,
          costMicros: sql<number>`coalesce(sum(${aiCallLogs.costMicros}), 0)::bigint`,
          tokens: sql<number>`coalesce(sum(${aiCallLogs.inputTokens}) + sum(${aiCallLogs.outputTokens}), 0)::bigint`,
        })
        .from(aiCallLogs)
        .where(gte(aiCallLogs.createdAt, sevenDaysAgo)),
      this.db
        .select({
          running: sql<number>`count(*) filter (where ${backgroundJobs.status} = ${JobStatus.Running})::int`,
          pending: sql<number>`count(*) filter (where ${backgroundJobs.status} = ${JobStatus.Queued})::int`,
          failed: sql<number>`count(*) filter (where ${backgroundJobs.status} = ${JobStatus.Failed})::int`,
          dead: sql<number>`(select count(*)::int from ${failedJobs})`,
        })
        .from(backgroundJobs),
    ]);
    const mc = merchantCounts[0];
    const sc = subCounts[0];
    const mrrCents = mrr[0]?.mrrCents ?? 0;
    const ai = aiUsage[0];
    const sys = system[0];
    return {
      merchants: { total: mc?.total ?? 0, active: mc?.active ?? 0, uninstalled: mc?.uninstalled ?? 0 },
      subscriptions: {
        trialing: sc?.trialing ?? 0,
        active: sc?.active ?? 0,
        chargePending: sc?.chargePending ?? 0,
        trialExpired: sc?.trialExpired ?? 0,
        cancelled: sc?.cancelled ?? 0,
        suspended: sc?.suspended ?? 0,
      },
      modeledMrrCents: mrrCents,
      modeledArrCents: mrrCents * 12,
      ai: {
        runsLast7d: ai?.runs ?? 0,
        costMicrosLast7d: ai?.costMicros ?? 0,
        tokensLast7d: ai?.tokens ?? 0,
      },
      system: {
        jobsRunning: sys?.running ?? 0,
        jobsPending: sys?.pending ?? 0,
        jobsFailed: sys?.failed ?? 0,
        deadJobs: sys?.dead ?? 0,
      },
    };
  }

  /** Funnel from engagement milestones — delegated to the engagement service. */
  async activationFunnel(): ReturnType<EngagementService["funnel"]> {
    return new EngagementService(this.db).funnel();
  }

  async merchants(limit = 50, offset = 0): Promise<readonly MerchantRow[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await execRaw<RawMerchantRow>(this.db, sql`
      select
        s.id as "storeId",
        s.shop_domain as "shopDomain",
        s.name as "name",
        s.installed_at as "installedAt",
        p.code as "planCode",
        sub.status as "subscriptionStatus",
        sub.trial_ends_at as "trialEndsAt",
        coalesce((
          select sum(ro.attributed_revenue_cents)::bigint from recommendation_outcomes ro
          where ro.store_id = s.id
        ), 0) as "attributedRevenueCents",
        coalesce((
          select sum(acl.cost_micros)::bigint from ai_call_logs acl
          where acl.store_id = s.id and acl.created_at >= ${thirtyDaysAgo}
        ), 0) as "aiCostMicrosLast30d",
        (
          select max(ee.created_at) from engagement_events ee where ee.store_id = s.id
        ) as "lastActivityAt"
      from stores s
      left join subscriptions sub on sub.store_id = s.id
      left join plans p on p.id = sub.plan_id
      order by s.installed_at desc
      limit ${limit} offset ${offset}
    `);
    return rows.map((row) => ({
      ...row,
      // installed_at is NOT NULL — it always normalizes to a Date.
      installedAt: row.installedAt instanceof Date ? row.installedAt : new Date(row.installedAt),
      trialEndsAt: asDateOrNull(row.trialEndsAt),
      lastActivityAt: asDateOrNull(row.lastActivityAt),
    }));
  }

  /** Top AI cost drivers — margin watch + support lookups (P12 usage monitoring). */
  async aiUsageByStore(limit = 25): Promise<
    readonly { storeId: string; shopDomain: string; calls: number; tokens: number; costMicros: number }[]
  > {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.db
      .select({
        storeId: aiCallLogs.storeId,
        shopDomain: stores.shopDomain,
        calls: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${aiCallLogs.inputTokens}) + sum(${aiCallLogs.outputTokens}), 0)::bigint`,
        costMicros: sql<number>`coalesce(sum(${aiCallLogs.costMicros}), 0)::bigint`,
      })
      .from(aiCallLogs)
      .innerJoin(stores, eq(stores.id, aiCallLogs.storeId))
      .where(
        and(
          gte(aiCallLogs.createdAt, thirtyDaysAgo),
          inArray(aiCallLogs.status, [AiCallStatus.Succeeded, AiCallStatus.Failed]),
        ),
      )
      .groupBy(aiCallLogs.storeId, stores.shopDomain)
      .orderBy(desc(sql`coalesce(sum(${aiCallLogs.costMicros}), 0)`))
      .limit(limit);
  }
}
