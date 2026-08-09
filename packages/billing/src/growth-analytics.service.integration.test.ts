import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiCallLogs,
  aiRuns,
  backgroundJobs,
  engagementEvents,
  failedJobs,
  recommendations,
  recommendationOutcomes,
  subscriptions,
} from "@profit/db";
import { eq } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  AiAgentId,
  AiCallStatus,
  AiProviderId,
  AiRunStatus,
  AiRunTrigger,
  AttributionMethod,
  BillingInterval,
  EngagementEventKind,
  JobStatus,
  ModelTier,
  PlanCode,
  QueueName,
  RecommendationStatus,
  StoreStatus,
  SubscriptionStatus,
} from "@profit/types";
import { GrowthAnalyticsService } from "./growth-analytics.service";
import {
  bootBillingTestDb,
  seedBillingStore,
  seedSubscription,
  uniqueDomain,
} from "./test-support/integration";

const DAY = 24 * 3_600_000;
const ago = (ms: number): Date => new Date(Date.now() - ms);

let testDb: TestDatabase;
const service = () => new GrowthAnalyticsService(testDb.db);

async function aiCall(storeId: string, input: { createdAt: Date; costMicros: number; status: AiCallStatus; tokens?: number; runId?: string | null }) {
  await testDb.db.insert(aiCallLogs).values({
    storeId,
    runId: input.runId ?? null,
    agentId: AiAgentId.RevenueRecovery,
    provider: AiProviderId.Gemini,
    model: "gemini-2.5-pro",
    modelTier: ModelTier.Standard,
    promptId: "recovery.plan",
    promptVersion: "1",
    status: input.status,
    inputTokens: input.tokens ?? 100,
    outputTokens: input.tokens ?? 50,
    costMicros: input.costMicros,
    latencyMs: 800,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

beforeAll(async () => {
  testDb = await bootBillingTestDb();
});

afterAll(async () => {
  await testDb.close();
});

describe("ownerDashboard", () => {
  it("aggregates merchants, subscriptions, modeled MRR/ARR, AI burn and system health", async () => {
    // ── merchants ──
    const activeA = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("dash-a") });
    const activeB = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("dash-b") });
    await seedBillingStore(testDb.db, {
      shopDomain: uniqueDomain("dash-gone"),
      status: StoreStatus.Uninstalled,
    });

    // ── subscriptions across the whole lifecycle ──
    await seedSubscription(testDb.db, {
      storeId: activeA,
      planCode: PlanCode.Growth, // 7900 monthly → 7900 MRR
      status: SubscriptionStatus.Active,
      billingInterval: BillingInterval.Monthly,
      currentPeriodStart: ago(5 * DAY),
      currentPeriodEnd: new Date(Date.now() + 25 * DAY),
    });
    await seedSubscription(testDb.db, {
      storeId: activeB,
      planCode: PlanCode.Enterprise, // 999_000 yearly → 83_250 MRR
      status: SubscriptionStatus.Active,
      billingInterval: BillingInterval.Yearly,
      currentPeriodStart: ago(5 * DAY),
      currentPeriodEnd: new Date(Date.now() + 360 * DAY),
    });
    const statuses: [SubscriptionStatus, PlanCode][] = [
      [SubscriptionStatus.Trialing, PlanCode.Starter],
      [SubscriptionStatus.ChargePending, PlanCode.Growth],
      [SubscriptionStatus.TrialExpired, PlanCode.Growth],
      [SubscriptionStatus.Cancelled, PlanCode.Starter],
      [SubscriptionStatus.Suspended, PlanCode.Starter],
    ];
    for (const [status, plan] of statuses) {
      const store = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain(`dash-${status.toLowerCase()}`) });
      await seedSubscription(testDb.db, {
        storeId: store,
        planCode: plan,
        status,
        ...(status === SubscriptionStatus.ChargePending ? { shopifyChargeId: "CHG-DASH" } : {}),
      });
    }

    // ── AI burn: one run this week + calls in/out of the 7d window ──
    const runRows = await testDb.db
      .insert(aiRuns)
      .values({
        storeId: activeA,
        trigger: AiRunTrigger.Manual,
        status: AiRunStatus.Completed,
        recommendationsCreated: 2,
        startedAt: ago(2 * DAY),
        finishedAt: ago(2 * DAY - 3_600_000),
      })
      .returning();
    await aiCall(activeA, { createdAt: ago(2 * DAY), costMicros: 4_000, status: AiCallStatus.Succeeded, runId: runRows[0]!.id });
    await aiCall(activeA, { createdAt: ago(3 * DAY), costMicros: 6_000, status: AiCallStatus.Succeeded });
    await aiCall(activeA, { createdAt: ago(10 * DAY), costMicros: 99_000, status: AiCallStatus.Succeeded }); // outside 7d

    // ── system: one queued + one dead job ──
    await testDb.db.insert(backgroundJobs).values({
      storeId: activeA,
      queue: QueueName.Analytics,
      jobType: "analytics.rollup",
      payload: {},
      status: JobStatus.Queued,
      idempotencyKey: `dash-${randomUUID()}`,
    });
    await testDb.db.insert(failedJobs).values({
      storeId: activeA,
      queue: QueueName.Analytics,
      jobType: "analytics.rollup",
      payload: {},
      error: "boom",
    });

    const dashboard = await service().ownerDashboard();
    expect(dashboard.merchants.total).toBeGreaterThanOrEqual(8);
    expect(dashboard.merchants.uninstalled).toBe(1);
    expect(dashboard.subscriptions).toMatchObject({
      trialing: 1,
      active: 2,
      chargePending: 1,
      trialExpired: 1,
      cancelled: 1,
      suspended: 1,
    });
    expect(dashboard.modeledMrrCents).toBe(7900 + Math.floor(999_000 / 12));
    expect(dashboard.modeledArrCents).toBe(dashboard.modeledMrrCents * 12);
    expect(dashboard.ai.runsLast7d).toBe(1);
    expect(dashboard.ai.costMicrosLast7d).toBe(10_000);
    expect(dashboard.ai.tokensLast7d).toBe(2 * 150);
    expect(dashboard.system.jobsPending).toBe(1);
    expect(dashboard.system.deadJobs).toBe(1);
    expect(dashboard.system.jobsRunning).toBe(0);
  });
});

describe("merchants — the admin read model", () => {
  it("lists merchants newest-first with plan, attribution, AI cost and last activity", async () => {
    const oldest = await seedBillingStore(testDb.db, {
      shopDomain: uniqueDomain("merch-old"),
      name: "Old Merchants",
      installedAt: ago(9 * DAY),
    });
    const newest = await seedBillingStore(testDb.db, {
      shopDomain: uniqueDomain("merch-new"),
      name: "New Merchants",
    });
    await seedSubscription(testDb.db, {
      storeId: newest,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.Active,
      billingInterval: BillingInterval.Monthly,
    });

    // attribution + AI cost (30d) + activity for the newest store
    const recRows = await testDb.db
      .insert(recommendations)
      .values({
        storeId: newest,
        fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
        type: "RECOVER_ABANDONED_CART",
        agentId: "REVENUE_RECOVERY",
        ruleId: "cart.abandoned-recovery",
        title: "Recover recent abandoned carts",
        description: "Recovered carts via the recovery email workflow.",
        reasoning: ["point one", "point two"],
        priority: "HIGH",
        confidence: 90,
        riskLevel: "LOW",
        estimatedRevenueCents: 9_900,
        estimatedCostCents: 900,
        subjects: { checkoutTokens: ["t"] },
        actionType: "SEND_RECOVERY_EMAIL",
        actionParams: {},
        status: RecommendationStatus.Measured,
        expiresAt: new Date(Date.now() + 7 * DAY),
      })
      .returning();
    await testDb.db.insert(recommendationOutcomes).values({
      storeId: newest,
      recommendationId: recRows[0]!.id,
      method: AttributionMethod.CheckoutToken,
      windowDays: 14,
      attributedOrdersCount: 2,
      attributedRevenueCents: 21_400,
      measuredAt: ago(1 * DAY),
    });
    await aiCall(newest, { createdAt: ago(2 * DAY), costMicros: 7_500, status: AiCallStatus.Succeeded });
    await aiCall(newest, { createdAt: ago(40 * DAY), costMicros: 50_000, status: AiCallStatus.Succeeded }); // outside 30d
    await testDb.db.insert(engagementEvents).values({
      storeId: newest,
      kind: EngagementEventKind.StoreConnected,
      metadata: {},
      createdAt: ago(3 * 3_600_000),
      updatedAt: ago(3 * 3_600_000),
    });

    const rows = await service().merchants(50, 0);
    expect(rows[0]!.storeId).toBe(newest); // newest install first
    const newestRow = rows.find((row) => row.storeId === newest)!;
    expect(newestRow.planCode).toBe(PlanCode.Growth);
    expect(newestRow.subscriptionStatus).toBe(SubscriptionStatus.Active);
    expect(newestRow.attributedRevenueCents).toBe(21_400);
    expect(newestRow.aiCostMicrosLast30d).toBe(7_500);
    expect(newestRow.lastActivityAt).not.toBeNull();
    const oldestRow = rows.find((row) => row.storeId === oldest)!;
    expect(oldestRow.planCode).toBeNull();
    expect(oldestRow.attributedRevenueCents).toBe(0);

    // pagination is real
    const page = await service().merchants(1, 0);
    expect(page).toHaveLength(1);
    const ordered = await service().merchants(500, 0);
    const installedOrder = ordered.map((row) => row.installedAt.getTime());
    expect(installedOrder).toEqual([...installedOrder].sort((a, b) => b - a));
  });
});

describe("aiUsageByStore + funnel delegation", () => {
  it("ranks cost drivers over the last 30 days (failed calls burn money too)", async () => {
    const heavy = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("usage-heavy") });
    const light = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("usage-light") });
    await aiCall(heavy, { createdAt: ago(1 * DAY), costMicros: 40_000, status: AiCallStatus.Succeeded });
    await aiCall(heavy, { createdAt: ago(1 * DAY), costMicros: 10_000, status: AiCallStatus.Failed });
    await aiCall(light, { createdAt: ago(1 * DAY), costMicros: 1_000, status: AiCallStatus.Succeeded });

    const rows = await service().aiUsageByStore();
    const heavyRow = rows.find((row) => row.storeId === heavy)!;
    const lightRow = rows.find((row) => row.storeId === light)!;
    expect(heavyRow.costMicros).toBe(50_000);
    expect(heavyRow.calls).toBe(2);
    expect(lightRow.costMicros).toBe(1_000);
    expect(rows.indexOf(heavyRow)).toBeLessThan(rows.indexOf(lightRow));
  });

  it("activation funnel is the engagement service funnel (single source)", async () => {
    const storeId = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("funnel-growth") });
    const before = await service().activationFunnel();
    const base = new Map(before.map((row) => [row.kind, row.stores]));
    await testDb.db.insert(engagementEvents).values({
      storeId,
      kind: EngagementEventKind.StoreConnected,
      metadata: {},
    });
    const after = await service().activationFunnel();
    const connected = after.find((row) => row.kind === EngagementEventKind.StoreConnected)!;
    expect(connected.stores).toBe((base.get(EngagementEventKind.StoreConnected) ?? 0) + 1);
  });
});
