import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, billingEvents, eq, subscriptions } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  BillingEventType,
  BillingInterval,
  PlanCode,
  StoreStatus,
  SubscriptionStatus,
} from "@profit/types";
import { BillingService } from "./billing.service";
import { PENDING_DECISION_LIMIT_DAYS, ReconcileService, type ReconcileProvider } from "./reconcile.service";
import type { BillingChargeProvider, LiveSubscription } from "./ports";
import {
  bootBillingTestDb,
  fakeChargeProvider,
  seedBillingStore,
  seedSubscription,
  uniqueDomain,
} from "./test-support/integration";

const DAY = 24 * 3_600_000;
const ago = (ms: number): Date => new Date(Date.now() - ms);

let testDb: TestDatabase;

function reconcileService() {
  return new ReconcileService(testDb.db, new BillingService(testDb.db));
}

/** Provider map driven per-test; absent store ⇒ typed unavailability. */
class MapProviders implements ReconcileProvider {
  private readonly map = new Map<string, BillingChargeProvider>();
  set(storeId: string, provider: BillingChargeProvider | null): void {
    if (provider === null) this.map.delete(storeId);
    else this.map.set(storeId, provider);
  }
  forStore(storeId: string): Promise<BillingChargeProvider | null> {
    return Promise.resolve(this.map.get(storeId) ?? null);
  }
}

async function seedPending(storeId: string, chargeId: string, updatedAgoMs: number): Promise<void> {
  await seedSubscription(testDb.db, {
    storeId,
    planCode: PlanCode.Growth,
    status: SubscriptionStatus.ChargePending,
    shopifyChargeId: chargeId,
    billingInterval: BillingInterval.Monthly,
    trialEndsAt: new Date(Date.now() + 1 * DAY),
    graceEndsAt: new Date(Date.now() + 3 * DAY),
    updatedAt: ago(updatedAgoMs),
    createdAt: ago(updatedAgoMs),
  });
}

beforeAll(async () => {
  testDb = await bootBillingTestDb();
});

afterAll(async () => {
  await testDb.close();
});

describe("pending-charge settling", () => {
  it("gives the merchant a day to decide, then settles via the live API", async () => {
    const tooFresh = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("rec-fresh") });
    await seedPending(tooFresh, "CHG-1001", 6 * 3_600_000); // 6h old
    const decidable = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("rec-decide") });
    await seedPending(decidable, "CHG-1002", 2 * DAY); // 2d old

    const providers = new MapProviders();
    providers.set(tooFresh, fakeChargeProvider({ live: [] }).provider);
    providers.set(decidable, fakeChargeProvider({
      live: [{ chargeId: "CHG-1002", name: "Growth", status: "ACTIVE", test: true }],
    }).provider);

    const report = await reconcileService().tick(providers);
    expect(report.settled).toEqual([{ storeId: decidable, outcome: "ACTIVATED" }]);

    const freshRows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, tooFresh));
    expect(freshRows[0]!.status).toBe(SubscriptionStatus.ChargePending); // untouched
    const decidedRows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, decidable));
    expect(decidedRows[0]!.status).toBe(SubscriptionStatus.Active);
  });

  it("treats a stale decision screen as declined after the decision limit", async () => {
    expect(PENDING_DECISION_LIMIT_DAYS).toBe(7);
    const stale = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("rec-stale") });
    await seedPending(stale, "CHG-1003", 8 * DAY);
    const providers = new MapProviders();
    providers.set(stale, fakeChargeProvider({
      live: [{ chargeId: "CHG-1003", name: "Growth", status: "PENDING", test: true }],
    }).provider);

    const report = await reconcileService().tick(providers);
    expect(report.settled).toEqual([{ storeId: stale, outcome: "DECLINED_STALE" }]);
    const rows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, stale));
    expect(rows[0]!.status).toBe(SubscriptionStatus.Trialing); // trial still alive → safe fallback
    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, stale), eq(billingEvents.type, BillingEventType.ChargeDeclined)));
    expect(events).toHaveLength(1);
    expect((events[0]!.metadata as Record<string, unknown>)["reason"]).toBe("stale_decision_screen");
  });
});

describe("live-charge drift", () => {
  it("converges ACTIVE to CANCELLED when the charge vanished from Shopify", async () => {
    const drifted = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("rec-drift") });
    await seedSubscription(testDb.db, {
      storeId: drifted,
      planCode: PlanCode.Professional,
      status: SubscriptionStatus.Active,
      shopifyChargeId: "CHG-2001",
      billingInterval: BillingInterval.Monthly,
      currentPeriodStart: ago(10 * DAY),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    });
    const healthy = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("rec-healthy") });
    await seedSubscription(testDb.db, {
      storeId: healthy,
      planCode: PlanCode.Professional,
      status: SubscriptionStatus.Active,
      shopifyChargeId: "CHG-2002",
      billingInterval: BillingInterval.Monthly,
      currentPeriodStart: ago(10 * DAY),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    });

    const live: LiveSubscription[] = [
      { chargeId: "CHG-2002", name: "Professional", status: "ACTIVE", test: true },
    ];
    const providers = new MapProviders();
    providers.set(drifted, fakeChargeProvider({ live }).provider);
    providers.set(healthy, fakeChargeProvider({ live }).provider);

    const report = await reconcileService().tick(providers);
    expect(report.cancelledDrift).toEqual([drifted]);

    const driftedRows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, drifted));
    expect(driftedRows[0]!.status).toBe(SubscriptionStatus.Cancelled);
    expect(driftedRows[0]!.cancelledAt).not.toBeNull();
    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, drifted), eq(billingEvents.type, BillingEventType.ChargeReconciled)));
    expect(events).toHaveLength(1);
    expect((events[0]!.metadata as Record<string, unknown>)["reason"]).toBe("charge_missing_on_shopify");

    const healthyRows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, healthy));
    expect(healthyRows[0]!.status).toBe(SubscriptionStatus.Active); // untouched
  });

  it("skips stores without a resolvable provider (typed, counted, never simulated)", async () => {
    const orphan = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("rec-orphan") });
    await seedPending(orphan, "CHG-3001", 3 * DAY);
    const providers = new MapProviders(); // nothing registered
    const report = await reconcileService().tick(providers);
    expect(report.skippedNoProvider).toBeGreaterThanOrEqual(1);
    const rows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, orphan));
    expect(rows[0]!.status).toBe(SubscriptionStatus.ChargePending);
  });

  it("uninstalled stores are out of scope for reconciliation", async () => {
    const gone = await seedBillingStore(testDb.db, {
      shopDomain: uniqueDomain("rec-gone"),
      status: StoreStatus.Uninstalled,
    });
    await seedPending(gone, "CHG-3002", 3 * DAY);
    const providers = new MapProviders();
    providers.set(gone, fakeChargeProvider({ live: [] }).provider);
    const report = await reconcileService().tick(providers);
    expect(report.settled.some((row) => row.storeId === gone)).toBe(false);
    const rows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, gone));
    expect(rows[0]!.status).toBe(SubscriptionStatus.ChargePending);
  });
});
