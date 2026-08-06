import {
  aiCallLogs,
  and,
  eq,
  gte,
  lt,
  recommendationOutcomes,
  recommendations,
  sql,
  withStoreScope,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { AiCallStatus, Priority, RecommendationStatus } from "@profit/types";

/**
 * RoiReportService (P11 ROI reporting, M5): the honest value ledger behind the
 * Billing page ("what your plan recovered") and the D2 trial emails.
 *
 * Inputs are owned here in `@profit/ai`: attributed outcomes (measured, with
 * conviction) + per-call metered AI cost (micro$) + live open pipeline value.
 * Every figure is labeled modeled-where-modeled at the read-model edge — the
 * UI renders methodology copy from these flags verbatim.
 */

export interface RoiReport {
  readonly windowDays: number;
  readonly from: string;
  readonly to: string;
  /** Measured attribution inside the window (14-day conviction windows). */
  readonly outcomes: {
    readonly attributedRevenueCents: number;
    readonly attributedOrdersCount: number;
    readonly measuredRecommendations: number;
  };
  /** Deterministic estimates of everything still open (upside, not revenue). */
  readonly pipeline: {
    readonly openRecommendations: number;
    readonly openEstimatedRevenueCents: number;
    readonly highPriorityOpen: number;
  };
  /** AI compute spend inside the window (merchant sees the honest cost side). */
  readonly cost: {
    readonly micros: number;
    readonly calls: number;
  };
  /** attributedRevenue / cost — NULL when cost is zero (never Infinity math in UI). */
  readonly roiMultiple: number | null;
  /** Accepted/(accepted+rejected) decisions inside the window. */
  readonly acceptanceRatePct: number | null;
}

export const ROI_WINDOWS_DAYS = [30, 90] as const;
export type RoiWindowDays = (typeof ROI_WINDOWS_DAYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export class RoiReportService {
  constructor(private readonly db: ProfitDb) {}

  async report(storeId: string, windowDays: RoiWindowDays = 30, now = new Date()): Promise<RoiReport> {
    const to = now;
    const from = new Date(now.getTime() - windowDays * DAY_MS);
    return withStoreScope(this.db, storeId, async (tx) => {
      const [outcomeRows, pipelineRows, costRows, decisionRows] = await Promise.all([
        tx
          .select({
            revenue: sql<number>`coalesce(sum(${recommendationOutcomes.attributedRevenueCents}), 0)::bigint`,
            orders: sql<number>`coalesce(sum(${recommendationOutcomes.attributedOrdersCount}), 0)::int`,
            measured: sql<number>`count(*) filter (where ${recommendationOutcomes.attributedRevenueCents} > 0 or ${recommendationOutcomes.attributedOrdersCount} > 0)::int`,
          })
          .from(recommendationOutcomes)
          .where(
            and(
              eq(recommendationOutcomes.storeId, storeId),
              gte(recommendationOutcomes.measuredAt, from),
              lt(recommendationOutcomes.measuredAt, to),
            ),
          ),
        tx
          .select({
            open: sql<number>`count(*)::int`,
            estimatedCents: sql<number>`coalesce(sum(${recommendations.estimatedRevenueCents}), 0)::bigint`,
            high: sql<number>`count(*) filter (where ${recommendations.priority} in (${Priority.High}, ${Priority.Critical}))::int`,
          })
          .from(recommendations)
          .where(
            and(
              eq(recommendations.storeId, storeId),
              sql`${recommendations.status} in (${RecommendationStatus.PendingApproval}, ${RecommendationStatus.Approved}, ${RecommendationStatus.Scheduled}, ${RecommendationStatus.Executing})`,
            ),
          ),
        tx
          .select({
            micros: sql<number>`coalesce(sum(${aiCallLogs.costMicros}), 0)::bigint`,
            calls: sql<number>`count(*)::int`,
          })
          .from(aiCallLogs)
          .where(
            and(
              eq(aiCallLogs.storeId, storeId),
              eq(aiCallLogs.status, AiCallStatus.Succeeded),
              gte(aiCallLogs.createdAt, from),
              lt(aiCallLogs.createdAt, to),
            ),
          ),
        tx
          .select({
            decided: sql<number>`count(*)::int`,
            accepted: sql<number>`count(*) filter (where ${recommendations.status} = ${RecommendationStatus.Approved})::int`,
          })
          .from(recommendations)
          .where(
            and(
              eq(recommendations.storeId, storeId),
              sql`${recommendations.status} in (${RecommendationStatus.Approved}, ${RecommendationStatus.Rejected})`,
              gte(recommendations.decidedAt, from),
              lt(recommendations.decidedAt, to),
            ),
          ),
      ]);

      const outcomes = outcomeRows[0];
      const pipeline = pipelineRows[0];
      const cost = costRows[0];
      const decisions = decisionRows[0];
      const revenueCents = outcomes?.revenue ?? 0;
      const micros = cost?.micros ?? 0;

      return {
        windowDays,
        from: from.toISOString(),
        to: to.toISOString(),
        outcomes: {
          attributedRevenueCents: revenueCents,
          attributedOrdersCount: outcomes?.orders ?? 0,
          measuredRecommendations: outcomes?.measured ?? 0,
        },
        pipeline: {
          openRecommendations: pipeline?.open ?? 0,
          openEstimatedRevenueCents: pipeline?.estimatedCents ?? 0,
          highPriorityOpen: pipeline?.high ?? 0,
        },
        cost: { micros, calls: cost?.calls ?? 0 },
        roiMultiple:
          micros > 0 && revenueCents > 0
            ? Math.round(((revenueCents * 1_000_000) / micros) * 10) / 10
            : null,
        acceptanceRatePct:
          decisions !== undefined && decisions.decided > 0
            ? Math.round((decisions.accepted / decisions.decided) * 100)
            : null,
      };
    });
  }
}
