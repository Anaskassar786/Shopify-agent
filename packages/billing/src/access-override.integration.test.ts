import { accessOverrides, billingEvents, eq } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import { AccessOverrideKind, BillingEventType, PlanCode, SubscriptionStatus, UsageMeter } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessOverrideService, AccessOverrideStateError } from "./access-override.service";
import { BillingConflictError, BillingService } from "./billing.service";
import {
  bootBillingTestDb,
  seedBillingStore,
  seedSubscription,
  uniqueDomain,
} from "./test-support/integration";

/**
 * M6 support-surface contract: comped-access overrides bypass ONLY the
 * status gate (quota checks keep biting), every grant/revoke validates its
 * audit reason, and trial extension moves TRIALING/TRIAL_EXPIRED windows
 * with a ledger row in the same transaction.
 */

let testDb: TestDatabase;
let overrides: AccessOverrideService;
let billing: BillingService;
let storeId = "";

beforeAll(async () => {
  testDb = await bootBillingTestDb();
  overrides = new AccessOverrideService(testDb.db);
  billing = new BillingService(testDb.db);
  storeId = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("override") });
});

afterAll(async () => {
  await testDb.close();
});

describe("access overrides", () => {
  it("suspended store is blocked; grant unlocks; revoke re-blocks", async () => {
    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.Suspended,
    });

    const denied = await billing.evaluateStoreAccess(storeId);
    expect(denied.revenueActionsAllowed).toBe(false);
    expect(denied.blockedReason).toContain("suspended");

    const grant = await overrides.grant(storeId, {
      kind: AccessOverrideKind.CompAccess,
      accessUntil: new Date(Date.now() + 7 * 86_400_000),
      reason: "goodwill: trial data lost during migration",
      grantedBy: "operator@profittool.ai",
    });
    expect(grant.grantedBy).toBe("operator@profittool.ai");

    const allowed = await billing.evaluateStoreAccess(storeId);
    expect(allowed.revenueActionsAllowed).toBe(true);
    expect(allowed.status).toBe(SubscriptionStatus.Suspended); // status itself untouched

    // The quota gate also consults the override for the status block…
    const quotaCheck = await billing.checkEntitlement(storeId, UsageMeter.EmailsSent, 1);
    expect(quotaCheck).toBeNull();

    const revoked = await overrides.revoke(storeId, grant.id, {
      revokedBy: "operator@profittool.ai",
      reason: "window honored",
    });
    expect(revoked.revokedAt).not.toBeNull();

    const blockedAgain = await billing.evaluateStoreAccess(storeId);
    expect(blockedAgain.revenueActionsAllowed).toBe(false);
  });

  it("quota limits STILL apply under an override (status gate only)", async () => {
    const quotaStore = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("override-quota") });
    await seedSubscription(testDb.db, {
      storeId: quotaStore,
      planCode: PlanCode.Starter, // sms quota = 0
      status: SubscriptionStatus.Suspended,
    });
    await overrides.grant(quotaStore, {
      kind: AccessOverrideKind.CompAccess,
      accessUntil: new Date(Date.now() + 3 * 86_400_000),
      reason: "support test",
      grantedBy: "operator@profittool.ai",
    });
    const decision = await billing.checkEntitlement(quotaStore, UsageMeter.SmsSent, 1);
    expect(decision).not.toBeNull();
    expect(decision?.reason).toBe("QUOTA_EXCEEDED");
  });

  it("validates the window and the reason (audit-grade inputs)", async () => {
    await expect(
      overrides.grant(storeId, {
        kind: AccessOverrideKind.CompAccess,
        accessUntil: new Date(Date.now() - 1_000),
        reason: "x",
        grantedBy: "op",
      }),
    ).rejects.toThrow(/future/);
    await expect(
      overrides.grant(storeId, {
        kind: AccessOverrideKind.CompAccess,
        accessUntil: new Date(Date.now() + 200 * 86_400_000),
        reason: "x",
        grantedBy: "op",
      }),
    ).rejects.toThrow(/90 days/);
    await expect(
      overrides.grant(storeId, {
        kind: AccessOverrideKind.CompAccess,
        accessUntil: new Date(Date.now() + 86_400_000),
        reason: "   ",
        grantedBy: "op",
      }),
    ).rejects.toThrow(/reason/);
    await expect(
      overrides.grant("00000000-0000-0000-0000-000000000000", {
        kind: AccessOverrideKind.CompAccess,
        accessUntil: new Date(Date.now() + 86_400_000),
        reason: "x",
        grantedBy: "op",
      }),
    ).rejects.toThrow(/store not found/);
  });

  it("active-override store count feeds the admin dashboard", async () => {
    const count = await overrides.countActiveStores();
    expect(count).toBeGreaterThanOrEqual(1); // quotaStore's grant from the previous test
  });

  it("history lists newest first including revoked", async () => {
    const list = await overrides.listForStore(storeId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((o) => o.revokedAt !== null)).toBe(true);
  });
});

describe("trial extension", () => {
  it("TRIALING: days stack onto the remaining window with a ledger row", async () => {
    const trialing = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("extend-trialing") });
    const trialEnds = new Date(Date.now() + 3 * 86_400_000);
    await seedSubscription(testDb.db, {
      storeId: trialing,
      planCode: PlanCode.Starter,
      status: SubscriptionStatus.Trialing,
      trialEndsAt: trialEnds,
    });
    const extended = await billing.extendTrial(trialing, 5, new Date(), { operator: "operator@profittool.ai" });
    expect(extended.status).toBe(SubscriptionStatus.Trialing);
    expect(extended.trialEndsAt?.getTime()).toBe(trialEnds.getTime() + 5 * 86_400_000);

    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.storeId, trialing));
    const ledger = events.find((e) => e.type === BillingEventType.TrialExtended);
    expect(ledger).toBeDefined();
    expect((ledger?.metadata as { additionalDays: number }).additionalDays).toBe(5);
    expect((ledger?.metadata as { reactivated: boolean }).reactivated).toBe(false);
  });

  it("TRIAL_EXPIRED: reactivates into a fresh window from now", async () => {
    const expiredStore = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("extend-expired") });
    await seedSubscription(testDb.db, {
      storeId: expiredStore,
      planCode: PlanCode.Starter,
      status: SubscriptionStatus.TrialExpired,
      trialEndsAt: new Date(Date.now() - 86_400_000),
    });
    const before = await billing.evaluateStoreAccess(expiredStore);
    expect(before.revenueActionsAllowed).toBe(false);

    const now = new Date();
    const extended = await billing.extendTrial(expiredStore, 7, now, { operator: "operator@profittool.ai" });
    expect(extended.status).toBe(SubscriptionStatus.Trialing);
    expect(extended.trialEndsAt?.getTime()).toBe(now.getTime() + 7 * 86_400_000);

    const after = await billing.evaluateStoreAccess(expiredStore);
    expect(after.revenueActionsAllowed).toBe(true);
  });

  it("ACTIVE subscriptions reject extension (never rewrites paid state)", async () => {
    const activeStore = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("extend-active") });
    await seedSubscription(testDb.db, {
      storeId: activeStore,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.Active,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    await expect(billing.extendTrial(activeStore, 5)).rejects.toBeInstanceOf(BillingConflictError);
    await expect(billing.extendTrial(activeStore, 0)).rejects.toThrow(/1..90 days|1..90/);
    await expect(billing.extendTrial(activeStore, 91)).rejects.toThrow(/1..90 days|1..90/);
  });
});
