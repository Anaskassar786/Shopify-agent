import {
  actionExecutions,
  aiCallLogs,
  and,
  campaigns,
  eq,
  gte,
  lt,
  messageEvents,
  sql,
  stores,
  subscriptions,
  usageRecords,
  workflowRuns,
  workflowRunSteps,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  ActionType,
  AiCallStatus,
  MessageChannel,
  MessageEventKind,
  UsageMeter,
  WorkflowNodeKind,
  WorkflowStepStatus,
} from "@profit/types";

/**
 * UsageRollupService — convergent daily rollups into `usage_records` (the
 * queryable projection enforcement does NOT trust; it is for Billing-UI usage
 * bars, admin margin analytics and M5 invoice-grade record keeping).
 *
 * Idempotent by construction: rows are upserted by (store, meter, day) from
 * the metering sources of truth, so re-running any window is always safe.
 * The sweep is bounded (recent days only) — this job is a formatter, not an
 * archiver.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many days back each tick re-computes (covers late clock skew + retries). */
const ROLLUP_LOOKBACK_DAYS = 2;

function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class UsageRollupService {
  constructor(private readonly db: ProfitDb) {}

  /**
   * Roll up [today-lookback, today) UTC buckets for every active store.
   * Runs as the platform owner (rollup is cross-tenant maintenance; it only
   * ever writes each store's own bucket rows).
   */
  async rollUpAll(now = new Date()): Promise<{ stores: number; bucketsWritten: number }> {
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = new Date(to.getTime() - ROLLUP_LOOKBACK_DAYS * DAY_MS);
    const storeRows = await this.db
      .select({ id: stores.id, installedAt: stores.installedAt })
      .from(stores);

    let bucketsWritten = 0;
    for (const store of storeRows) {
      const periodStart = await this.periodStartFor(store.id, store.installedAt);
      // AI calls + cost per day
      const aiRows = await this.db
        .select({
          day: sql<string>`to_char(${aiCallLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          used: sql<number>`count(*)::int`,
          cost: sql<number>`coalesce(sum(${aiCallLogs.costMicros}), 0)::bigint`,
        })
        .from(aiCallLogs)
        .where(
          and(
            eq(aiCallLogs.storeId, store.id),
            gte(aiCallLogs.createdAt, from),
            lt(aiCallLogs.createdAt, to),
          ),
        )
        .groupBy(sql`to_char(${aiCallLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
      for (const row of aiRows) {
        bucketsWritten += await this.writeBucket(store.id, UsageMeter.AiCalls, row.day, periodStart, row.used, row.cost);
      }

      // Emails sent per day — ALL sources summed into one convergent bucket:
      // M4 recovery-email tool checkpoints + M6 campaign SENT events + M6
      // workflow SEND_EMAIL steps. Sources can never double-count (disjoint
      // ledgers), and the daily bucket is rewritten whole from the sum.
      const m4EmailRows = await this.db
        .select({
          day: sql<string>`to_char(${actionExecutions.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          used: sql<number>`coalesce(sum(case when jsonb_typeof(${actionExecutions.toolRef} -> 'sentTo') = 'array' then jsonb_array_length(${actionExecutions.toolRef} -> 'sentTo') else 0 end), 0)::int`,
        })
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.storeId, store.id),
            eq(actionExecutions.actionType, ActionType.SendRecoveryEmail),
            gte(actionExecutions.createdAt, from),
            lt(actionExecutions.createdAt, to),
          ),
        )
        .groupBy(sql`to_char(${actionExecutions.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
      const campaignMessageRows = await this.db
        .select({
          channel: campaigns.channel,
          day: sql<string>`to_char(${messageEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          used: sql<number>`count(*)::int`,
        })
        .from(messageEvents)
        .innerJoin(campaigns, eq(messageEvents.campaignId, campaigns.id))
        .where(
          and(
            eq(messageEvents.storeId, store.id),
            eq(messageEvents.kind, MessageEventKind.Sent),
            gte(messageEvents.createdAt, from),
            lt(messageEvents.createdAt, to),
          ),
        )
        .groupBy(campaigns.channel, sql`to_char(${messageEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
      // Group by the plain column (never a CASE with params: $1/$2 make the
      // GROUP BY expression structurally different and PG rejects the query).
      const workflowSendRows = await this.db
        .select({
          nodeKind: workflowRunSteps.nodeKind,
          day: sql<string>`to_char(${workflowRunSteps.completedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          used: sql<number>`count(*)::int`,
        })
        .from(workflowRunSteps)
        .where(
          and(
            eq(workflowRunSteps.storeId, store.id),
            sql`${workflowRunSteps.nodeKind} IN (${WorkflowNodeKind.SendEmail}, ${WorkflowNodeKind.SendSms})`,
            eq(workflowRunSteps.status, WorkflowStepStatus.Completed),
            gte(workflowRunSteps.completedAt, from),
            lt(workflowRunSteps.completedAt, to),
          ),
        )
        .groupBy(workflowRunSteps.nodeKind, sql`to_char(${workflowRunSteps.completedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

      const emailByDay = new Map<string, number>();
      const smsByDay = new Map<string, number>();
      const bump = (map: Map<string, number>, day: string, used: number): void => {
        map.set(day, (map.get(day) ?? 0) + used);
      };
      for (const row of m4EmailRows) bump(emailByDay, row.day, row.used);
      for (const row of campaignMessageRows) {
        bump(row.channel === MessageChannel.Sms ? smsByDay : emailByDay, row.day, row.used);
      }
      for (const row of workflowSendRows) {
        bump(row.nodeKind === WorkflowNodeKind.SendSms ? smsByDay : emailByDay, row.day, row.used);
      }
      for (const [day, used] of emailByDay) {
        bucketsWritten += await this.writeBucket(store.id, UsageMeter.EmailsSent, day, periodStart, used, 0);
      }
      for (const [day, used] of smsByDay) {
        bucketsWritten += await this.writeBucket(store.id, UsageMeter.SmsSent, day, periodStart, used, 0);
      }

      // Automation runs per day (M4 action executions + M6 workflow runs)
      const automationRows = await this.db
        .select({
          day: sql<string>`to_char(${actionExecutions.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          used: sql<number>`count(*)::int`,
        })
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.storeId, store.id),
            sql`${actionExecutions.startedAt} is not null`,
            gte(actionExecutions.startedAt, from),
            lt(actionExecutions.startedAt, to),
          ),
        )
        .groupBy(sql`to_char(${actionExecutions.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
      const workflowRunRows = await this.db
        .select({
          day: sql<string>`to_char(${workflowRuns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          used: sql<number>`count(*)::int`,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.storeId, store.id),
            gte(workflowRuns.createdAt, from),
            lt(workflowRuns.createdAt, to),
          ),
        )
        .groupBy(sql`to_char(${workflowRuns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
      const automationByDay = new Map<string, number>();
      for (const row of automationRows) bump(automationByDay, row.day, row.used);
      for (const row of workflowRunRows) bump(automationByDay, row.day, row.used);
      for (const [day, used] of automationByDay) {
        bucketsWritten += await this.writeBucket(store.id, UsageMeter.AutomationRuns, day, periodStart, used, 0);
      }
    }
    return { stores: storeRows.length, bucketsWritten };
  }

  private async periodStartFor(storeId: string, installedAt: Date): Promise<string | null> {
    const rows = await this.db
      .select({ currentPeriodStart: subscriptions.currentPeriodStart })
      .from(subscriptions)
      .where(eq(subscriptions.storeId, storeId))
      .limit(1);
    const start = rows[0]?.currentPeriodStart ?? null;
    if (start === null) return null;
    return dayKeyOf(start);
  }

  private async writeBucket(
    storeId: string,
    meter: UsageMeter,
    day: string,
    periodStart: string | null,
    count: number,
    costMicros: number,
  ): Promise<number> {
    await this.db
      .insert(usageRecords)
      .values({
        storeId,
        meter,
        bucketDate: day,
        periodStart,
        count,
        costMicros,
      })
      .onConflictDoUpdate({
        target: [usageRecords.storeId, usageRecords.meter, usageRecords.bucketDate],
        set: { count, costMicros, periodStart, updatedAt: new Date() },
      });
    return 1;
  }
}
