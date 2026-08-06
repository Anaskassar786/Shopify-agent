import { and, eq, inArray, lt, sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  actionExecutions,
  execRaw,
  recommendations,
  recommendationEvents,
  recommendationOutcomes,
  withStoreScope,
} from "@profit/db";
import {
  ActionType,
  AttributionMethod,
  EventActorType,
  RecommendationEventType,
  RecommendationStatus,
} from "@profit/types";
import { z } from "zod";

/**
 * Attribution v1 (P3 impact measurement, P11 credibility). Revenue is linked
 * to executed actions by DETERMINISTIC SQL — never by AI assertion:
 *
 *   CHECKOUT_TOKEN  order.checkout_token = the recovered checkout's token
 *   DISCOUNT_CODE   order.discount_codes contains our created code, after send
 *   CUSTOMER_WINDOW order.customer_id ∈ email subjects within N days of send
 *
 * Every outcome row carries its linkage evidence ({orderIds, matchedBy}).
 * Rows are unique per recommendation — the daily sweep is idempotent.
 */

export const MEASUREMENT_WINDOW_DAYS = 14;
const MAX_LINKED_ORDER_IDS = 50;

const linkedOrderRow = z.object({
  id: z.string().uuid(),
  total_cents: z.coerce.number(),
});

export interface MeasurementSummary {
  readonly measured: number;
  readonly expired: number;
  readonly attributedRevenueCents: number;
}

export class AttributionService {
  constructor(private readonly db: ProfitDb) {}

  /** Close measurement windows for one store (or every active store via tick fan-out). */
  async measureStore(storeId: string, now: Date = new Date()): Promise<MeasurementSummary> {
    const windowStart = new Date(now.getTime() - MEASUREMENT_WINDOW_DAYS * 86_400_000);
    let measured = 0;
    let attributedRevenue = 0;

    // Expire stale open rows first — expired recommendations never measure.
    const expired = await withStoreScope(this.db, storeId, async (tx) => {
      const stale = await tx
        .select({
          id: recommendations.id,
          status: recommendations.status,
          stateVersion: recommendations.stateVersion,
        })
        .from(recommendations)
        .where(
          and(
            eq(recommendations.storeId, storeId),
            inArray(recommendations.status, [
              RecommendationStatus.PendingApproval,
              RecommendationStatus.Approved,
              RecommendationStatus.Scheduled,
            ]),
            lt(recommendations.expiresAt, now),
          ),
        );
      for (const row of stale) {
        const updated = await tx
          .update(recommendations)
          .set({
            status: RecommendationStatus.Expired,
            stateVersion: row.stateVersion + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(recommendations.id, row.id),
              inArray(recommendations.status, [
                RecommendationStatus.PendingApproval,
                RecommendationStatus.Approved,
                RecommendationStatus.Scheduled,
              ]),
          ),
          )
          .returning({ id: recommendations.id });
        if (updated[0] !== undefined) {
          await tx.insert(recommendationEvents).values({
            storeId,
            recommendationId: row.id,
            event: RecommendationEventType.Expired,
            actorType: EventActorType.System,
            fromStatus: row.status as RecommendationStatus,
            toStatus: RecommendationStatus.Expired,
            details: {},
          });
        }
      }
      return stale.length;
    });

    // Executed tool actions whose window has closed and which lack an outcome.
    const pending = await withStoreScope(this.db, storeId, async (tx) => {
      return tx
        .select()
        .from(recommendations)
        .where(
          and(
            eq(recommendations.storeId, storeId),
            eq(recommendations.status, RecommendationStatus.Executed),
            inArray(recommendations.actionType, [
              ActionType.SendRecoveryEmail,
              ActionType.CreateDiscountCode,
            ]),
            lt(recommendations.decidedAt, windowStart),
          ),
        )
        .limit(200); // bounded sweep; remainder measures on the next tick
    });

    for (const rec of pending) {
      const outcome = await this.measureOne(storeId, rec, now);
      if (outcome !== null) {
        measured += 1;
        attributedRevenue += outcome.attributedRevenueCents;
      }
    }
    return { measured, expired, attributedRevenueCents: attributedRevenue };
  }

  private async measureOne(
    storeId: string,
    rec: typeof recommendations.$inferSelect,
    now: Date,
  ): Promise<{ readonly attributedRevenueCents: number } | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const already = await tx
        .select({ id: recommendationOutcomes.id })
        .from(recommendationOutcomes)
        .where(eq(recommendationOutcomes.recommendationId, rec.id))
        .limit(1);
      if (already[0] !== undefined) return null;

      const execution = (
        await tx
          .select()
          .from(actionExecutions)
          .where(
            and(
              eq(actionExecutions.recommendationId, rec.id),
              eq(actionExecutions.status, "SUCCEEDED"),
            ),
          )
          .limit(1)
      )[0];
      // No successful execution recorded → nothing measurable (FAILED stays).
      if (execution === undefined) return null;
      const toolRef = (execution.toolRef ?? {}) as Record<string, unknown>;
      const subjects = (rec.subjects ?? {}) as {
        checkoutTokens?: string[];
        customerIds?: string[];
      };

      let method: z.infer<typeof attributionMethod> | null = null;
      let rows: z.infer<typeof linkedOrderRow>[] = [];
      const sentAt = execution.finishedAt ?? execution.createdAt;
      const windowEnd = new Date(sentAt.getTime() + MEASUREMENT_WINDOW_DAYS * 86_400_000);

      if (rec.actionType === ActionType.SendRecoveryEmail && typeof toolRef["checkoutToken"] === "string") {
        method = AttributionMethod.CheckoutToken;
        rows = z.array(linkedOrderRow).parse(
          await execRaw<unknown>(
            tx,
            sqlForCheckoutAttribution(storeId, toolRef["checkoutToken"]),
          ),
        );
      }
      if (rows.length === 0 && typeof toolRef["discountCode"] === "string") {
        method = AttributionMethod.DiscountCode;
        rows = z.array(linkedOrderRow).parse(
          await execRaw<unknown>(
            tx,
            sqlForDiscountAttribution(storeId, toolRef["discountCode"], sentAt, windowEnd),
          ),
        );
      }
      if (rows.length === 0 && (subjects.customerIds?.length ?? 0) > 0) {
        method = AttributionMethod.CustomerWindow;
        rows = z.array(linkedOrderRow).parse(
          await execRaw<unknown>(
            tx,
            sqlForCustomerWindowAttribution(storeId, subjects.customerIds ?? [], sentAt, windowEnd),
          ),
        );
      }
      if (method === null) return null;

      const attributedRevenueCents = rows.reduce((sum, row) => sum + row.total_cents, 0);
      await tx.insert(recommendationOutcomes).values({
        storeId,
        recommendationId: rec.id,
        executionId: execution.id,
        method,
        windowDays: MEASUREMENT_WINDOW_DAYS,
        attributedOrdersCount: rows.length,
        attributedRevenueCents,
        linkage: {
          matchedBy: method,
          orderIds: rows.slice(0, MAX_LINKED_ORDER_IDS).map((row) => row.id),
          truncated: rows.length > MAX_LINKED_ORDER_IDS,
        },
        measuredAt: now,
      });
      await tx
        .update(recommendations)
        .set({
          status: RecommendationStatus.Measured,
          stateVersion: rec.stateVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(recommendations.id, rec.id));
      await tx.insert(recommendationEvents).values({
        storeId,
        recommendationId: rec.id,
        event: RecommendationEventType.Measured,
        actorType: EventActorType.System,
        fromStatus: RecommendationStatus.Executed,
        toStatus: RecommendationStatus.Measured,
        details: { method, attributedRevenueCents, attributedOrders: rows.length },
      });
      return { attributedRevenueCents };
    });
  }
}

const attributionMethod = z.enum([
  AttributionMethod.CheckoutToken,
  AttributionMethod.DiscountCode,
  AttributionMethod.CustomerWindow,
]);

/* Parameterized SQL (drizzle sql template — values bound, never interpolated). */

function sqlForCheckoutAttribution(storeId: string, token: string) {
  return sql`
    SELECT o.id, COALESCE(ROUND(o.total_price::numeric * 100),0)::bigint AS total_cents
    FROM shopify_orders o
    WHERE o.store_id = ${storeId} AND o.checkout_token = ${token} AND o.is_test = false
    ORDER BY o.processed_at ASC LIMIT 5`;
}

function sqlForDiscountAttribution(storeId: string, code: string, sentAt: Date, windowEnd: Date) {
  return sql`
    SELECT o.id, COALESCE(ROUND(o.total_price::numeric * 100),0)::bigint AS total_cents
    FROM shopify_orders o
    WHERE o.store_id = ${storeId} AND o.is_test = false
      AND o.discount_codes @> ${JSON.stringify([{ code }])}::jsonb
      AND o.processed_at >= ${sentAt.toISOString()}::timestamptz
      AND o.processed_at <= ${windowEnd.toISOString()}::timestamptz
    ORDER BY o.processed_at ASC LIMIT ${MAX_LINKED_ORDER_IDS * 2}`;
}

function sqlForCustomerWindowAttribution(
  storeId: string,
  customerIds: readonly string[],
  sentAt: Date,
  windowEnd: Date,
) {
  return sql`
    SELECT o.id, COALESCE(ROUND(o.total_price::numeric * 100),0)::bigint AS total_cents
    FROM shopify_orders o
    WHERE o.store_id = ${storeId} AND o.is_test = false
      AND o.customer_id IN (${sql.join(customerIds.map((id) => sql`${id}::uuid`), sql`,`)})
      AND o.processed_at >= ${sentAt.toISOString()}::timestamptz
      AND o.processed_at <= ${windowEnd.toISOString()}::timestamptz
    ORDER BY o.processed_at ASC LIMIT ${MAX_LINKED_ORDER_IDS * 2}`;
}
