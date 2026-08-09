import { and, desc, eq, sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  actionExecutions,
  aiRuns,
  execRaw,
  recommendations,
  recommendationEvents,
  recommendationOutcomes,
  withStoreScope,
} from "@profit/db";
import { RecommendationStatus } from "@profit/types";
import { z } from "zod";
import { parseAutomationPolicy } from "../context/builder";
import type { AutomationPolicy } from "../context/types";
import { storeSettings } from "@profit/db";

/**
 * Overview queries for the AI Command Center + Automation surfaces. All
 * aggregates come from the decision-plane tables themselves — the UI never
 * recomputes AI state client-side (one source of truth).
 */

const openCountRow = z.object({ status: z.string(), total: z.coerce.number() });
const totalsRow = z.object({
  acceptance_decided: z.coerce.number(),
  accepted: z.coerce.number(),
  attributed_cents: z.coerce.number(),
  attributed_orders: z.coerce.number(),
  open_high: z.coerce.number(),
});

export interface AiOverview {
  readonly engine: {
    readonly lastRunAt: string | null;
    readonly lastRunStatus: string | null;
    readonly lastRunTrigger: string | null;
    readonly runsLast7d: number;
    readonly costMicrosLast7d: number;
    readonly tokensLast7d: number;
  };
  readonly health: {
    readonly score: number | null;
    readonly computedAt: string | null;
    readonly components: unknown;
  };
  readonly open: {
    readonly pendingApproval: number;
    readonly approved: number;
    readonly executing: number;
    readonly highPriorityOpen: number;
  };
  readonly outcomes: {
    readonly acceptanceRatePct: number | null;
    readonly attributedRevenueCents: number;
    readonly attributedOrders: number;
  };
  readonly recentEvents: readonly {
    readonly id: string;
    readonly recommendationId: string;
    readonly event: string;
    readonly actorType: string;
    readonly title: string;
    readonly type: string;
    readonly createdAt: Date;
  }[];
}

export interface AutomationOverview {
  readonly policy: AutomationPolicy;
  readonly executions: readonly {
    readonly id: string;
    readonly recommendationId: string;
    readonly recommendationTitle: string;
    readonly type: string;
    readonly actionType: string;
    readonly status: string;
    readonly errorMessage: string | null;
    readonly attempts: number;
    readonly preview: unknown;
    readonly createdAt: Date;
    readonly finishedAt: Date | null;
  }[];
  readonly outcomes: {
    readonly attributedRevenueCents: number;
    readonly attributedOrders: number;
    readonly measuredCount: number;
  };
}

export class AiOverviewService {
  constructor(private readonly db: ProfitDb) {}

  async overview(storeId: string): Promise<AiOverview> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const [latestRunRows, runStatsRows, openRows, totalsRows, eventRows] = await Promise.all([
        tx
          .select()
          .from(aiRuns)
          .where(eq(aiRuns.storeId, storeId))
          .orderBy(desc(aiRuns.startedAt))
          .limit(1),
        execRaw<{ runs: string; cost: string; tokens: string }>(
          tx,
          sql`SELECT COUNT(*)::text AS runs,
                     COALESCE(SUM((usage->>'costMicros')::bigint),0)::text AS cost,
                     COALESCE(SUM((usage->>'inputTokens')::bigint + (usage->>'outputTokens')::bigint),0)::text AS tokens
              FROM ai_runs
              WHERE store_id = ${storeId} AND started_at >= now() - interval '7 days'`,
        ),
        execRaw<unknown>(
          tx,
          sql`SELECT status, COUNT(*)::bigint AS total FROM recommendations
              WHERE store_id = ${storeId} AND status IN ('PENDING_APPROVAL','APPROVED','SCHEDULED','EXECUTING')
              GROUP BY status`,
        ),
        execRaw<unknown>(
          tx,
          sql`SELECT
                COUNT(*) FILTER (WHERE r.status IN ('APPROVED','SCHEDULED','EXECUTING','EXECUTED','MEASURED','REJECTED'))::bigint AS acceptance_decided,
                COUNT(*) FILTER (WHERE r.status IN ('APPROVED','SCHEDULED','EXECUTING','EXECUTED','MEASURED'))::bigint AS accepted,
                COALESCE((SELECT SUM(attributed_revenue_cents) FROM recommendation_outcomes WHERE store_id = ${storeId}),0)::bigint AS attributed_cents,
                COALESCE((SELECT SUM(attributed_orders_count) FROM recommendation_outcomes WHERE store_id = ${storeId}),0)::bigint AS attributed_orders,
                COUNT(*) FILTER (WHERE r.status = 'PENDING_APPROVAL' AND r.priority IN ('HIGH','CRITICAL'))::bigint AS open_high
              FROM recommendations r WHERE r.store_id = ${storeId}`,
        ),
        tx
          .select({
            id: recommendationEvents.id,
            recommendationId: recommendationEvents.recommendationId,
            event: recommendationEvents.event,
            actorType: recommendationEvents.actorType,
            title: recommendations.title,
            type: recommendations.type,
            createdAt: recommendationEvents.createdAt,
          })
          .from(recommendationEvents)
          .innerJoin(
            recommendations,
            eq(recommendationEvents.recommendationId, recommendations.id),
          )
          .where(eq(recommendationEvents.storeId, storeId))
          .orderBy(desc(recommendationEvents.createdAt))
          .limit(20),
      ]);

      const run = latestRunRows[0];
      const runStats = runStatsRows[0] ?? { runs: "0", cost: "0", tokens: "0" };
      const open = z.array(openCountRow).parse(openRows);
      const totals = totalsRow.parse({
        acceptance_decided: 0, accepted: 0, attributed_cents: 0, attributed_orders: 0, open_high: 0,
        ...(totalsRows[0] ?? {}),
      });
      const statusCount = (status: string): number =>
        open.find((row) => row.status === status)?.total ?? 0;

      return {
        engine: {
          lastRunAt: run?.startedAt.toISOString() ?? null,
          lastRunStatus: run?.status ?? null,
          lastRunTrigger: run?.trigger ?? null,
          runsLast7d: Number(runStats.runs),
          costMicrosLast7d: Number(runStats.cost),
          tokensLast7d: Number(runStats.tokens),
        },
        health: {
          score: run?.storeHealthScore ?? null,
          computedAt: run?.finishedAt.toISOString() ?? null,
          components: run?.storeHealthBreakdown ?? null,
        },
        open: {
          pendingApproval: statusCount(RecommendationStatus.PendingApproval),
          approved: statusCount(RecommendationStatus.Approved),
          executing:
            statusCount(RecommendationStatus.Executing) + statusCount(RecommendationStatus.Scheduled),
          highPriorityOpen: totals.open_high,
        },
        outcomes: {
          acceptanceRatePct:
            totals.acceptance_decided > 0
              ? Math.round((totals.accepted / totals.acceptance_decided) * 100)
              : null,
          attributedRevenueCents: totals.attributed_cents,
          attributedOrders: totals.attributed_orders,
        },
        recentEvents: eventRows,
      };
    });
  }

  async automationOverview(storeId: string): Promise<AutomationOverview> {
    const settingsRows = await this.db
      .select({ automationPreferences: storeSettings.automationPreferences })
      .from(storeSettings)
      .where(eq(storeSettings.storeId, storeId))
      .limit(1);
    const policy = parseAutomationPolicy(settingsRows[0]?.automationPreferences);

    return withStoreScope(this.db, storeId, async (tx) => {
      const [executionRows, outcomeRows] = await Promise.all([
        tx
          .select({
            id: actionExecutions.id,
            recommendationId: actionExecutions.recommendationId,
            recommendationTitle: recommendations.title,
            type: recommendations.type,
            actionType: actionExecutions.actionType,
            status: actionExecutions.status,
            errorMessage: actionExecutions.errorMessage,
            attempts: actionExecutions.attempts,
            preview: actionExecutions.actionPreview,
            createdAt: actionExecutions.createdAt,
            finishedAt: actionExecutions.finishedAt,
          })
          .from(actionExecutions)
          .innerJoin(
            recommendations,
            eq(actionExecutions.recommendationId, recommendations.id),
          )
          .where(eq(actionExecutions.storeId, storeId))
          .orderBy(desc(actionExecutions.createdAt))
          .limit(20),
        execRaw<{ cents: string; orders: string; measured: string }>(
          tx,
          sql`SELECT COALESCE(SUM(attributed_revenue_cents),0)::text AS cents,
                     COALESCE(SUM(attributed_orders_count),0)::text AS orders,
                     COUNT(*)::text AS measured
              FROM recommendation_outcomes WHERE store_id = ${storeId}`,
        ),
      ]);
      const totals = outcomeRows[0] ?? { cents: "0", orders: "0", measured: "0" };
      return {
        policy,
        executions: executionRows,
        outcomes: {
          attributedRevenueCents: Number(totals.cents),
          attributedOrders: Number(totals.orders),
          measuredCount: Number(totals.measured),
        },
      };
    });
  }
}
