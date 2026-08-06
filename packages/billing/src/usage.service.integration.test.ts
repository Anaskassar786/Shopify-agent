import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionExecutions, aiCallLogs, eq, recommendations, usageRecords } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  ActionType,
  AiAgentId,
  AiCallStatus,
  AiProviderId,
  BillingInterval,
  ExecutionStatus,
  ModelTier,
  PlanCode,
  RecommendationStatus,
  SubscriptionStatus,
  UsageMeter,
} from "@profit/types";
import { UsageRollupService } from "./usage.service";
import {
  bootBillingTestDb,
  seedBillingStore,
  seedSubscription,
  uniqueDomain,
} from "./test-support/integration";

const DAY = 24 * 3_600_000;
/** 00:00 UTC today — the rollup's exclusive upper bound. */
function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

let testDb: TestDatabase;
const service = () => new UsageRollupService(testDb.db);

function aiCall(storeId: string, createdAt: Date, costMicros: number, status: AiCallStatus = AiCallStatus.Succeeded) {
  return testDb.db.insert(aiCallLogs).values({
    storeId,
    agentId: AiAgentId.BusinessAnalyst,
    provider: AiProviderId.Gemini,
    model: "gemini-2.5-flash",
    modelTier: ModelTier.Triage,
    promptId: "context.build",
    promptVersion: "1",
    status,
    inputTokens: 60,
    outputTokens: 40,
    costMicros,
    latencyMs: 500,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    createdAt,
    updatedAt: createdAt,
  });
}

async function recommendation(storeId: string): Promise<string> {
  const rows = await testDb.db
    .insert(recommendations)
    .values({
      storeId,
      fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      type: "RECOVER_ABANDONED_CART",
      agentId: "REVENUE_RECOVERY",
      ruleId: "cart.abandoned-recovery",
      title: "Recover recent abandoned carts",
      description: "Carts went cold with high recovery odds.",
      reasoning: ["point one", "point two"],
      priority: "HIGH",
      confidence: 80,
      riskLevel: "LOW",
      estimatedRevenueCents: 1200,
      estimatedCostCents: 900,
      subjects: { checkoutTokens: ["t"] },
      actionType: "SEND_RECOVERY_EMAIL",
      actionParams: {},
      status: RecommendationStatus.Approved,
      expiresAt: new Date(Date.now() + 7 * DAY),
    })
    .returning({ id: recommendations.id });
  return rows[0]!.id;
}

function execution(input: {
  storeId: string;
  recommendationId: string;
  actionType: ActionType;
  status: ExecutionStatus;
  createdAt: Date;
  startedAt: Date | null;
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
    startedAt: input.startedAt,
  });
}

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

beforeAll(async () => {
  testDb = await bootBillingTestDb();
});

afterAll(async () => {
  await testDb.close();
});

describe("rollUpAll", () => {
  it("writes per-day buckets from the metering sources; re-runs converge", async () => {
    const today = utcToday();
    const yesterday = new Date(today.getTime() - DAY + 3_600_000); // 01:00 UTC yesterday
    const dayBefore = new Date(today.getTime() - 2 * DAY + 3_600_000);
    const tooOld = new Date(today.getTime() - 3 * DAY);

    const storeId = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("rollup") });
    // ACTIVE paid sub → periodStart rides the buckets
    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.Active,
      billingInterval: BillingInterval.Monthly,
      currentPeriodStart: dayBefore,
      currentPeriodEnd: new Date(today.getTime() + 28 * DAY),
    });

    await aiCall(storeId, yesterday, 1000);
    await aiCall(storeId, yesterday, 2000);
    await aiCall(storeId, dayBefore, 500);
    await aiCall(storeId, tooOld, 9999); // outside the 2-day lookback — never rolled up
    const recId = await recommendation(storeId);
    await execution({
      storeId,
      recommendationId: recId,
      actionType: ActionType.SendRecoveryEmail,
      status: ExecutionStatus.Succeeded,
      createdAt: yesterday,
      startedAt: yesterday,
      toolRef: { sentTo: ["a@x.test", "b@x.test"] },
    });
    await execution({
      storeId,
      recommendationId: recId,
      actionType: ActionType.CreateDiscountCode,
      status: ExecutionStatus.Succeeded,
      createdAt: yesterday,
      startedAt: yesterday,
    });
    await execution({
      storeId,
      recommendationId: recId,
      actionType: ActionType.SendRecoveryEmail,
      status: ExecutionStatus.Pending, // no send checkpoint → zero email units; no startedAt → no run
      createdAt: yesterday,
      startedAt: null,
    });

    const first = await service().rollUpAll();
    expect(first.stores).toBeGreaterThanOrEqual(1);
    expect(first.bucketsWritten).toBeGreaterThanOrEqual(4); // ai×2 days + email×1 + automation×1

    const rows = await testDb.db.select().from(usageRecords).where(eq(usageRecords.storeId, storeId));
    const key = (meter: UsageMeter, date: Date) =>
      rows.find((row) => row.meter === meter && row.bucketDate === dayKey(date));

    const aiYesterday = key(UsageMeter.AiCalls, yesterday);
    expect(aiYesterday).toMatchObject({ count: 2, costMicros: 3000 });
    expect(aiYesterday!.periodStart).toBe(dayKey(dayBefore));
    expect(key(UsageMeter.AiCalls, dayBefore)).toMatchObject({ count: 1, costMicros: 500 });
    expect(key(UsageMeter.AiCalls, tooOld)).toBeUndefined();
    expect(key(UsageMeter.EmailsSent, yesterday)).toMatchObject({ count: 2, costMicros: 0 });
    expect(key(UsageMeter.AutomationRuns, yesterday)).toMatchObject({ count: 2, costMicros: 0 });

    // Convergent: a second tick re-computes the same buckets without exploding rows.
    await service().rollUpAll();
    const after = await testDb.db.select().from(usageRecords).where(eq(usageRecords.storeId, storeId));
    expect(after).toHaveLength(rows.length);
  });

  it("trial stores keep metering (periodStart stays null)", async () => {
    const today = utcToday();
    const yesterday = new Date(today.getTime() - DAY + 2 * 3_600_000);
    const storeId = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("rollup-trial") });
    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Starter,
      status: SubscriptionStatus.Trialing,
      trialEndsAt: new Date(Date.now() + 2 * DAY),
    });
    await aiCall(storeId, yesterday, 700, AiCallStatus.Failed); // failures ARE cost/meter truth too
    await aiCall(storeId, yesterday, 700);
    await service().rollUpAll();
    const rows = await testDb.db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.storeId, storeId));
    const bucket = rows.find((row) => row.meter === UsageMeter.AiCalls);
    expect(bucket).toMatchObject({ count: 2, costMicros: 1400, periodStart: null });
  });
});
