import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actionExecutions,
  aiCallLogs,
  billingEvents,
  eq,
  recommendations,
  subscriptions,
} from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  ActionType,
  AiAgentId,
  AiCallStatus,
  AiProviderId,
  BillingEventType,
  BillingInterval,
  ExecutionStatus,
  ModelTier,
  PlanCode,
  RecommendationStatus,
  SubscriptionStatus,
  UsageMeter,
} from "@profit/types";
import {
  BillingConflictError,
  BillingProviderUnavailableError,
  BillingService,
  remainingTrialDays,
  usageWindowFor,
} from "./billing.service";
import {
  fakeChargeProvider,
  bootBillingTestDb,
  seedBillingStore,
  seedSubscription,
  uniqueDomain,
} from "./test-support/integration";

const DAY = 24 * 3_600_000;
const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY);

let testDb: TestDatabase;
const service = () => new BillingService(testDb.db);

async function newStore(tag: string, installedAt?: Date): Promise<string> {
  return seedBillingStore(testDb.db, { shopDomain: uniqueDomain(tag), ...(installedAt !== undefined ? { installedAt } : {}) });
}

async function subRow(storeId: string) {
  const rows = await testDb.db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.storeId, storeId));
  return rows[0];
}

async function ledgerFor(storeId: string) {
  return testDb.db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.storeId, storeId))
    .orderBy(billingEvents.createdAt, billingEvents.id);
}

function seedAiCall(storeId: string, status: AiCallStatus, createdAt: Date, costMicros = 1200) {
  return testDb.db.insert(aiCallLogs).values({
    storeId,
    agentId: AiAgentId.RevenueRecovery,
    provider: AiProviderId.Gemini,
    model: "gemini-2.5-pro",
    modelTier: ModelTier.Standard,
    promptId: "recovery.reply",
    promptVersion: "1",
    status,
    inputTokens: 100,
    outputTokens: 50,
    costMicros,
    latencyMs: 900,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    createdAt,
    updatedAt: createdAt,
  });
}

async function seedRecommendation(storeId: string): Promise<string> {
  const rows = await testDb.db
    .insert(recommendations)
    .values({
      storeId,
      fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      type: "RECOVER_ABANDONED_CART",
      agentId: "REVENUE_RECOVERY",
      ruleId: "cart.abandoned-recovery",
      title: "Recover recent abandoned carts",
      description: "Three carts went cold in the last day with high recovery odds.",
      reasoning: ["point one", "point two"],
      priority: "HIGH",
      confidence: 81,
      riskLevel: "LOW",
      estimatedRevenueCents: 15_200,
      estimatedCostCents: 960,
      subjects: { checkoutTokens: ["t1"] },
      actionType: "SEND_RECOVERY_EMAIL",
      actionParams: { template: "RECOVERY" },
      status: RecommendationStatus.PendingApproval,
      expiresAt: daysFromNow(7),
    })
    .returning({ id: recommendations.id });
  return rows[0]!.id;
}

function seedExecution(input: {
  storeId: string;
  recommendationId: string;
  actionType: ActionType;
  status: ExecutionStatus;
  createdAt: Date;
  startedAt?: Date | null;
  toolRef?: Record<string, unknown>;
}) {
  return testDb.db.insert(actionExecutions).values({
    storeId: input.storeId,
    recommendationId: input.recommendationId,
    actionType: input.actionType,
    status: input.status,
    idempotencyKey: createHash("sha256").update(randomUUID()).digest("hex"),
    toolRef: input.toolRef ?? {},
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    startedAt: input.startedAt ?? null,
  });
}

beforeAll(async () => {
  testDb = await bootBillingTestDb();
});

afterAll(async () => {
  await testDb.close();
});

describe("getSubscriptionState / startTrial", () => {
  it("returns nulls before onboarding, then a TRIALING row + TRIAL_STARTED ledger entry", async () => {
    const storeId = await newStore("trial");
    expect(await service().getSubscriptionState(storeId)).toEqual({ subscription: null, plan: null });

    const started = await service().startTrial(storeId, PlanCode.Growth);
    expect(started.created).toBe(true);
    expect(started.subscription.status).toBe(SubscriptionStatus.Trialing);
    const trialMs = started.subscription.trialEndsAt!.getTime() - Date.now();
    expect(trialMs).toBeGreaterThan(2.9 * DAY);
    expect(trialMs).toBeLessThan(3.1 * DAY);

    const events = await ledgerFor(storeId);
    expect(events.map((e) => e.type)).toEqual([BillingEventType.TrialStarted]);
    expect(events[0]!.planCode).toBe(PlanCode.Growth);

    const state = await service().getSubscriptionState(storeId);
    expect(state.plan?.code).toBe(PlanCode.Growth);
    expect(state.plan?.entitlements.quotas.automationRuns).toBe(1000);
    expect(state.plan?.isActive).toBe(true);

    // Idempotent: re-clicks never create a second trial.
    const again = await service().startTrial(storeId, PlanCode.Starter);
    expect(again.created).toBe(false);
    expect(again.subscription.planId).toBe(started.subscription.planId);
    expect((await ledgerFor(storeId)).length).toBe(1);
  });

  it("evaluateStoreAccess gives a start-trial prompt when nothing exists", async () => {
    const storeId = await newStore("access-none");
    const access = await service().evaluateStoreAccess(storeId);
    expect(access).toEqual({
      revenueActionsAllowed: false,
      blockedReason: "Start your free trial to unlock revenue actions",
      status: null,
    });
  });
});

describe("subscribe → CHARGE_PENDING", () => {
  it("creates the charge, preserves remaining trial days and writes CHARGE_CREATED", async () => {
    const storeId = await newStore("subscribe");
    await service().startTrial(storeId, PlanCode.Growth);
    const fake = fakeChargeProvider({ chargeId: "CHG-9001", confirmationUrl: "https://confirm.example/x" });

    const result = await service().subscribe({
      storeId,
      planCode: PlanCode.Growth,
      interval: BillingInterval.Monthly,
      provider: fake.provider,
      returnUrl: "https://app.profit.test/api/v1/billing/callback",
      test: true,
    });
    expect(result).toEqual({ chargeId: "CHG-9001", confirmationUrl: "https://confirm.example/x" });

    const request = fake.createRequests[0]!;
    expect(request.amountCents).toBe(7900);
    expect(request.trialDays).toBe(3); // nearly-full trial preserved on the charge
    expect(request.test).toBe(true);
    expect(request.interval).toBe(BillingInterval.Monthly);

    const row = (await subRow(storeId))!;
    expect(row.status).toBe(SubscriptionStatus.ChargePending);
    expect(row.shopifyChargeId).toBe("CHG-9001");
    expect(row.billingInterval).toBe(BillingInterval.Monthly);
    expect(row.graceEndsAt).not.toBeNull();

    const types = (await ledgerFor(storeId)).map((e) => e.type);
    expect(types).toEqual([BillingEventType.TrialStarted, BillingEventType.ChargeCreated]);
  });

  it("subscribes from scratch (no trial) with a fresh trial window on the charge", async () => {
    const storeId = await newStore("subscribe-fresh");
    const fake = fakeChargeProvider({ chargeId: "CHG-9002" });
    await service().subscribe({
      storeId,
      planCode: PlanCode.Starter,
      interval: BillingInterval.Yearly,
      provider: fake.provider,
      returnUrl: "https://app.profit.test/callback",
      test: false,
    });
    const request = fake.createRequests[0]!;
    expect(request.amountCents).toBe(29_000);
    expect(request.trialDays).toBe(0); // no live trial → nothing to preserve
    const row = (await subRow(storeId))!;
    expect(row.status).toBe(SubscriptionStatus.ChargePending);
    expect(row.trialEndsAt).not.toBeNull();
  });

  it("refuses a second charge while ACTIVE, a null provider, and unknown plans", async () => {
    const storeId = await newStore("subscribe-guards");
    await expect(
      service().subscribe({
        storeId,
        planCode: PlanCode.Growth,
        interval: BillingInterval.Monthly,
        provider: null,
        returnUrl: "u",
        test: true,
      }),
    ).rejects.toBeInstanceOf(BillingProviderUnavailableError);

    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.Active,
      shopifyChargeId: "CHG-LIVE",
    });
    const fake = fakeChargeProvider();
    await expect(
      service().subscribe({
        storeId,
        planCode: PlanCode.Growth,
        interval: BillingInterval.Monthly,
        provider: fake.provider,
        returnUrl: "u",
        test: true,
      }),
    ).rejects.toBeInstanceOf(BillingConflictError);
    expect(fake.createRequests.length).toBe(0);
  });
});

describe("resolveChargeOutcome — the only path to ACTIVE", () => {
  async function pendingStore(tag: string, chargeId: string, trialEndsAt: Date | null) {
    const storeId = await newStore(tag);
    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.ChargePending,
      shopifyChargeId: chargeId,
      billingInterval: BillingInterval.Monthly,
      trialEndsAt,
      graceEndsAt: trialEndsAt !== null ? new Date(trialEndsAt.getTime() + 2 * DAY) : null,
    });
    return storeId;
  }

  it("ACTIVATED: period = now + preserved trial + cycle, ledger CHARGE_ACCEPTED", async () => {
    const trialEndsAt = daysFromNow(2.5);
    const storeId = await pendingStore("resolve-active", "CHG-7001", trialEndsAt);
    const fake = fakeChargeProvider({
      live: [{ chargeId: "CHG-7001", name: "Growth (monthly)", status: "ACTIVE", test: true }],
    });
    const before = Date.now();
    const outcome = await service().resolveChargeOutcome({ storeId, provider: fake.provider, source: "CALLBACK" });
    expect(outcome.outcome).toBe("ACTIVATED");
    if (outcome.outcome !== "ACTIVATED") throw new Error("narrowing");
    expect(outcome.chargeId).toBe("CHG-7001");
    expect(outcome.interval).toBe(BillingInterval.Monthly);

    const row = (await subRow(storeId))!;
    expect(row.status).toBe(SubscriptionStatus.Active);
    // preserved (ceil(2.5d)=3) + 30 cycle days
    const periodDays = (row.currentPeriodEnd!.getTime() - before) / DAY;
    expect(periodDays).toBeGreaterThan(32.5);
    expect(periodDays).toBeLessThan(33.5);
    const last = (await ledgerFor(storeId)).at(-1)!;
    expect(last.type).toBe(BillingEventType.ChargeAccepted);
    expect((last.metadata as Record<string, unknown>)["source"]).toBe("CALLBACK");
  });

  it("DECLINED (and vanished charges) fall back to the safest pre-charge state", async () => {
    const aliveTrial = await pendingStore("resolve-declined", "CHG-7002", daysFromNow(1));
    const fake = fakeChargeProvider({
      live: [{ chargeId: "CHG-7002", name: "Growth", status: "DECLINED", test: true }],
    });
    expect((await service().resolveChargeOutcome({ storeId: aliveTrial, provider: fake.provider, source: "CALLBACK" })).outcome).toBe("DECLINED");
    expect((await subRow(aliveTrial))!.status).toBe(SubscriptionStatus.Trialing);
    expect((await ledgerFor(aliveTrial)).at(-1)!.type).toBe(BillingEventType.ChargeDeclined);

    const deadTrial = await pendingStore("resolve-vanish", "CHG-7003", daysFromNow(-1));
    const vanishing = fakeChargeProvider({ live: [] }); // charge gone from Shopify
    const outcome = await service().resolveChargeOutcome({ storeId: deadTrial, provider: vanishing.provider, source: "RECONCILE" });
    expect(outcome.outcome).toBe("DECLINED");
    expect((await subRow(deadTrial))!.status).toBe(SubscriptionStatus.TrialExpired);

    const stillThinking = await pendingStore("resolve-pending", "CHG-7004", daysFromNow(1));
    const pendingLive = fakeChargeProvider({
      live: [{ chargeId: "CHG-7004", name: "Growth", status: "PENDING", test: true }],
    });
    const pending = await service().resolveChargeOutcome({ storeId: stillThinking, provider: pendingLive.provider, source: "CALLBACK" });
    expect(pending.outcome).toBe("PENDING");
    expect((await subRow(stillThinking))!.status).toBe(SubscriptionStatus.ChargePending);
  });

  it("NO_PENDING when the row is not charge-pending; unavailable provider is typed", async () => {
    const storeId = await newStore("resolve-nopending");
    expect(
      (await service().resolveChargeOutcome({ storeId, provider: null, source: "CALLBACK" })).outcome,
    ).toBe("NO_PENDING");

    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.ChargePending,
      shopifyChargeId: "CHG-7005",
    });
    await expect(
      service().resolveChargeOutcome({ storeId, provider: null, source: "CALLBACK" }),
    ).rejects.toBeInstanceOf(BillingProviderUnavailableError);
  });

  it("settleStalePending demotes without a provider call", async () => {
    const storeId = await pendingStore("resolve-stale", "CHG-7006", daysFromNow(-2));
    expect(await service().settleStalePending(storeId)).toBe(true);
    expect((await subRow(storeId))!.status).toBe(SubscriptionStatus.TrialExpired);
    const last = (await ledgerFor(storeId)).at(-1)!;
    expect(last.type).toBe(BillingEventType.ChargeDeclined);
    expect((last.metadata as Record<string, unknown>)["reason"]).toBe("stale_decision_screen");
    // already settled → nothing to do
    expect(await service().settleStalePending(storeId)).toBe(false);
  });
});

describe("cancel", () => {
  it("cancels the live charge and honors the pre-paid period", async () => {
    const storeId = await newStore("cancel");
    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Professional,
      status: SubscriptionStatus.Active,
      shopifyChargeId: "CHG-5100",
      billingInterval: BillingInterval.Monthly,
      currentPeriodStart: daysFromNow(-10),
      currentPeriodEnd: daysFromNow(20),
    });
    const fake = fakeChargeProvider();
    const result = await service().cancel({ storeId, provider: fake.provider });
    expect(result).toEqual({ cancelled: true });
    expect(fake.cancelRequests).toEqual(["CHG-5100"]);

    const row = (await subRow(storeId))!;
    expect(row.status).toBe(SubscriptionStatus.Cancelled);
    expect(row.cancelledAt).not.toBeNull();
    expect(row.currentPeriodEnd).not.toBeNull(); // honored until period end
    const last = (await ledgerFor(storeId)).at(-1)!;
    expect(last.type).toBe(BillingEventType.ChargeCancelled);
    expect((last.metadata as Record<string, unknown>)["honoredUntil"]).toContain("T");
  });

  it("rejects invalid cancellations precisely", async () => {
    const noCharge = await newStore("cancel-nocharge");
    await service().startTrial(noCharge, PlanCode.Growth);
    const fake = fakeChargeProvider();
    await expect(service().cancel({ storeId: noCharge, provider: fake.provider })).rejects.toBeInstanceOf(
      BillingConflictError,
    );

    const expired = await newStore("cancel-expired");
    await seedSubscription(testDb.db, {
      storeId: expired,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.TrialExpired,
      shopifyChargeId: "CHG-5101",
    });
    await expect(service().cancel({ storeId: expired, provider: fake.provider })).rejects.toBeInstanceOf(
      BillingConflictError,
    );

    const active = await newStore("cancel-noprovider");
    await seedSubscription(testDb.db, {
      storeId: active,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.Active,
      shopifyChargeId: "CHG-5102",
    });
    await expect(service().cancel({ storeId: active, provider: null })).rejects.toBeInstanceOf(
      BillingProviderUnavailableError,
    );
    expect(fake.cancelRequests.length).toBe(0);
  });
});

describe("usage metering + quota gate", () => {
  it("counts live at the metering sources of truth inside the TRIAL window", async () => {
    const storeId = await newStore("usage", daysFromNow(-1));
    await service().startTrial(storeId, PlanCode.Growth); // window: installedAt → trialEndsAt
    const inside = daysFromNow(-0.5);
    const outside = daysFromNow(-2); // before installedAt

    await seedAiCall(storeId, AiCallStatus.Succeeded, inside, 1500);
    await seedAiCall(storeId, AiCallStatus.Succeeded, inside, 2500);
    await seedAiCall(storeId, AiCallStatus.Failed, inside, 0); // failures never count
    await seedAiCall(storeId, AiCallStatus.Succeeded, outside, 9999); // outside the window

    const recId = await seedRecommendation(storeId);
    await seedExecution({
      storeId,
      recommendationId: recId,
      actionType: ActionType.SendRecoveryEmail,
      status: ExecutionStatus.Succeeded,
      createdAt: inside,
      startedAt: inside,
      toolRef: { sentTo: ["a@x.test", "b@x.test", "c@x.test"] },
    });
    await seedExecution({
      storeId,
      recommendationId: recId,
      actionType: ActionType.CreateDiscountCode,
      status: ExecutionStatus.Succeeded,
      createdAt: inside,
      startedAt: inside,
    });
    await seedExecution({
      storeId,
      recommendationId: recId,
      actionType: ActionType.SendRecoveryEmail,
      status: ExecutionStatus.Pending, // queued only — not a run, not a send
      createdAt: inside,
      startedAt: null,
    });

    const summary = await service().usageSummary(storeId);
    expect(summary.status).toBe(SubscriptionStatus.Trialing);
    const byMeter = new Map(summary.meters.map((meter) => [meter.meter, meter]));
    expect(byMeter.get(UsageMeter.AiCalls)).toMatchObject({ used: 2, limit: 2000 });
    expect(byMeter.get(UsageMeter.EmailsSent)).toMatchObject({ used: 3, limit: 10_000 });
    expect(byMeter.get(UsageMeter.AutomationRuns)).toMatchObject({ used: 2, limit: 1000 });
    expect(byMeter.get(UsageMeter.SmsSent)).toMatchObject({ used: 0, limit: 0 });
    expect(byMeter.get(UsageMeter.SmsSent)!.percentUsed).toBeNull();
    expect(byMeter.get(UsageMeter.AiCalls)!.percentUsed).toBe(0);
    expect(summary.window.to).toEqual(
      (await subRow(storeId))!.trialEndsAt,
    );
  });

  it("checkEntitlement denies precisely: inactive subscription, then quota breach", async () => {
    const noSub = await newStore("gate-nosub");
    const denied = await service().checkEntitlement(noSub, UsageMeter.AiCalls);
    expect(denied?.reason).toBe("SUBSCRIPTION_INACTIVE");

    const overQuota = await newStore("gate-quota", daysFromNow(-1));
    await service().startTrial(overQuota, PlanCode.Starter); // quota: 20 automation runs
    const recId = await seedRecommendation(overQuota);
    await seedExecution({
      storeId: overQuota,
      recommendationId: recId,
      actionType: ActionType.CreateDiscountCode,
      status: ExecutionStatus.Running,
      createdAt: daysFromNow(-0.5),
      startedAt: daysFromNow(-0.5),
    });
    // 19 more units requested on top of the 1 recorded → 20+19-1… assert the boundary
    const allowed = await service().checkEntitlement(overQuota, UsageMeter.AutomationRuns, 19);
    expect(allowed).toBeNull();
    const blocked = await service().checkEntitlement(overQuota, UsageMeter.AutomationRuns, 20);
    expect(blocked?.reason).toBe("QUOTA_EXCEEDED");
    expect(blocked?.details).toMatchObject({ meter: UsageMeter.AutomationRuns, limit: 20, used: 1 });
    expect(blocked!.message).toContain("Starter");

    const expiredTrial = await newStore("gate-expired");
    await seedSubscription(testDb.db, {
      storeId: expiredTrial,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.TrialExpired,
      trialEndsAt: daysFromNow(-1),
    });
    const inactive = await service().checkEntitlement(expiredTrial, UsageMeter.EmailsSent);
    expect(inactive?.reason).toBe("SUBSCRIPTION_INACTIVE");
    expect(inactive?.message).toContain("Upgrade to continue");
  });
});

describe("catalog, history, transition + pure helpers", () => {
  it("listPlans returns the seeded catalog in price order with the current plan marked", async () => {
    const storeId = await newStore("catalog");
    await service().startTrial(storeId, PlanCode.Professional);
    const catalog = await service().listPlans(storeId);
    expect(catalog.plans.map((plan) => plan.code)).toEqual([
      PlanCode.Starter,
      PlanCode.Growth,
      PlanCode.Professional,
      PlanCode.Enterprise,
    ]);
    const state = await service().getSubscriptionState(storeId);
    expect(catalog.currentPlanId).toBe(state.plan!.id);
    expect(catalog.plans[0]!.entitlements.quotas.aiCalls).toBe(100);
  });

  it("history is newest-first and transition writes a same-tx ledger entry", async () => {
    const storeId = await newStore("history");
    await service().startTrial(storeId, PlanCode.Growth);
    const flipped = await service().transition({
      storeId,
      to: SubscriptionStatus.Suspended,
      eventType: BillingEventType.SubscriptionSuspended,
      metadata: { reason: "test" },
    });
    expect(flipped).toBe(true);
    expect(await service().transition({
      storeId,
      to: SubscriptionStatus.Suspended,
      eventType: BillingEventType.SubscriptionSuspended,
    })).toBe(false); // no-op never writes a duplicate ledger row

    const events = await service().history(storeId);
    expect(events.map((e) => e.type)).toEqual([
      BillingEventType.SubscriptionSuspended,
      BillingEventType.TrialStarted,
    ]);
    expect(events[0]!.fromStatus).toBe(SubscriptionStatus.Trialing);
    expect(events[0]!.toStatus).toBe(SubscriptionStatus.Suspended);

    const stranger = await newStore("history-none");
    expect(await service().transition({
      storeId: stranger,
      to: SubscriptionStatus.Suspended,
      eventType: BillingEventType.SubscriptionSuspended,
    })).toBe(false); // no subscription row → nothing to transition
  });

  it("usageWindowFor + remainingTrialDays encode the metering window rules", () => {
    const now = new Date("2026-08-06T12:00:00Z");
    const installedAt = new Date("2026-08-01T12:00:00Z");
    const trialEnd = new Date("2026-08-04T12:00:00Z");
    const trialing = {
      id: "s", storeId: "x", planId: "p", status: SubscriptionStatus.Trialing,
      shopifyChargeId: null, billingInterval: null, trialEndsAt: trialEnd,
      currentPeriodStart: null, currentPeriodEnd: null, graceEndsAt: null, cancelledAt: null,
    } as const;
    expect(usageWindowFor(trialing, installedAt, now)).toEqual({ from: installedAt, to: trialEnd });
    expect(usageWindowFor(null, installedAt, now)).toEqual({ from: installedAt, to: now });
    const active = {
      ...trialing,
      status: SubscriptionStatus.Active,
      trialEndsAt: null,
      currentPeriodStart: new Date("2026-08-05T00:00:00Z"),
      currentPeriodEnd: new Date("2026-09-04T00:00:00Z"),
    } as const;
    expect(usageWindowFor(active, installedAt, now).from).toEqual(new Date("2026-08-05T00:00:00Z"));

    expect(remainingTrialDays(trialing, new Date("2026-08-02T13:00:00Z"))).toBe(2);
    expect(remainingTrialDays(trialing, now)).toBe(0); // expired → nothing preserved
    expect(remainingTrialDays(active, now)).toBe(0); // paid period, no trial left to preserve
    // CHARGE_PENDING keeps trialEndsAt by construction — activation honors it.
    const pendingMidCharge = { ...trialing, status: SubscriptionStatus.ChargePending } as const;
    expect(remainingTrialDays(pendingMidCharge, new Date("2026-08-02T13:00:00Z"))).toBe(2);
    expect(remainingTrialDays(null, now)).toBe(0);
    // preserved days are hard-capped (Shopify trial extension guard)
    const longTrial = { ...trialing, trialEndsAt: new Date(now.getTime() + 200 * DAY) } as const;
    expect(remainingTrialDays(longTrial, now)).toBe(90);
  });
});

describe("tenant isolation (RLS through withStoreScope)", () => {
  it("reads never leak across stores", async () => {
    const a = await newStore("rls-a");
    const b = await newStore("rls-b");
    await service().startTrial(a, PlanCode.Enterprise);
    const bState = await service().getSubscriptionState(b);
    expect(bState.subscription).toBeNull();
    expect(await service().history(b)).toEqual([]);
    const aUsage = await service().usageSummary(a);
    const bUsage = await service().usageSummary(b);
    expect(aUsage.status).toBe(SubscriptionStatus.Trialing);
    expect(bUsage.status).toBeNull();
  });
});
