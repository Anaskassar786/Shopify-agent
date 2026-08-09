import { and, eq, inArray, lt, stores, subscriptions } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { BillingEventType, StoreStatus, SubscriptionStatus } from "@profit/types";
import { BillingService } from "./billing.service";
import type { BillingChargeProvider } from "./ports";

/**
 * ReconcileService — the daily drift corrector (P5 continuity: the platform
 * converges to Shopify's truth without depending on webhook delivery for
 * billing, which Shopify does not push as webhooks for app charges).
 *
 *  - CHARGE_PENDING rows: settle via resolveChargeOutcome (live read).
 *  - ACTIVE/PAST_DUE rows whose charge vanished from the live API: converge
 *    to CANCELLED (event CHARGE_RECONCILED) — merchant cancelled from Shopify.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A pending charge older than this without acceptance is treated as declined. */
export const PENDING_DECISION_LIMIT_DAYS = 7;

export interface ReconcileProvider {
  /**
   * Per-store charge provider lookup. Async because the composition root
   * resolves (and decrypts) the store's OFFLINE token per call. null ⇒ typed
   * unavailability: the row is skipped and counted, never simulated.
   */
  forStore(storeId: string): Promise<BillingChargeProvider | null>;
}

export class ReconcileService {
  constructor(
    private readonly db: ProfitDb,
    private readonly billing: BillingService,
  ) {}

  async tick(providers: ReconcileProvider, now = new Date()): Promise<{
    settled: readonly { storeId: string; outcome: string }[];
    cancelledDrift: readonly string[];
    skippedNoProvider: number;
  }> {
    const settled: { storeId: string; outcome: string }[] = [];
    const cancelledDrift: string[] = [];
    let skippedNoProvider = 0;

    const candidates = await this.db
      .select({
        storeId: subscriptions.storeId,
        status: subscriptions.status,
        chargeId: subscriptions.shopifyChargeId,
        subscriptionUpdatedAt: subscriptions.updatedAt,
      })
      .from(subscriptions)
      .innerJoin(stores, and(eq(stores.id, subscriptions.storeId), eq(stores.status, StoreStatus.Active)))
      .where(
        inArray(subscriptions.status, [
          SubscriptionStatus.ChargePending,
          SubscriptionStatus.Active,
          SubscriptionStatus.PastDue,
        ]),
      );

    for (const row of candidates) {
      const provider = await providers.forStore(row.storeId);
      if (provider === null) {
        skippedNoProvider += 1;
        continue;
      }

      if (row.status === SubscriptionStatus.ChargePending) {
        const ageDays = (now.getTime() - row.subscriptionUpdatedAt.getTime()) / DAY_MS;
        if (ageDays < 1) continue; // give merchants a day to decide before polling
        const result = await this.billing.resolveChargeOutcome({
          storeId: row.storeId,
          provider,
          source: "RECONCILE",
          now,
        });
        if (result.outcome !== "NO_PENDING" && result.outcome !== "PENDING") {
          settled.push({ storeId: row.storeId, outcome: result.outcome });
        } else if (result.outcome === "PENDING" && ageDays > PENDING_DECISION_LIMIT_DAYS) {
          // Stale decision screen: the charge visually never resolved — treat as declined.
          const declined = await this.billing.settleStalePending(row.storeId, now);
          if (declined) settled.push({ storeId: row.storeId, outcome: "DECLINED_STALE" });
        }
        continue;
      }

      // ACTIVE / PAST_DUE: the stored charge must exist on the live API.
      if (row.chargeId === null) continue;
      const live = await provider.fetchLiveSubscriptions();
      if (live.some((s) => s.chargeId === row.chargeId)) continue;
      await this.billing.transition({
        storeId: row.storeId,
        to: SubscriptionStatus.Cancelled,
        eventType: BillingEventType.ChargeReconciled,
        extra: { cancelledAt: now },
        metadata: {
          reason: "charge_missing_on_shopify",
          chargeId: row.chargeId,
          fromStatus: row.status,
        },
        now,
      });
      cancelledDrift.push(row.storeId);
    }

    return { settled, cancelledDrift, skippedNoProvider };
  }
}
