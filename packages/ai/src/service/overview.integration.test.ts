import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actionExecutions,
  aiRuns,
  recommendations,
  recommendationOutcomes,
  withStoreScope,
} from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import { AiRunTrigger, RecommendationEventType, RecommendationStatus, EventActorType } from "@profit/types";
import { recommendationEvents } from "@profit/db";
import { AiOverviewService } from "./overview";
import { bootAiTestDb, seedStore } from "../test-support/integration";

/** Overview aggregates contract — the AI Command Center reads HERE only. */

let testDb: TestDatabase;
let storeId = "";

beforeAll(async () => {
  testDb = await bootAiTestDb();
  storeId = await seedStore(testDb.db, {
    shopDomain: "overview-store.myshopify.com",
    automation: {
      mode: "SEMI_AUTOMATIC",
      abandonedCart: { enabled: true, delayHours: 8, minCartValueCents: 5_000, discountPercent: 15 },
    },
  });

  await withStoreScope(testDb.db, storeId, async (tx) => {
    await tx.insert(aiRuns).values({
      storeId,
      trigger: AiRunTrigger.Scheduled,
      status: "COMPLETED",
      storeHealthScore: 71,
      storeHealthBreakdown: { components: [] },
      agentsPlanned: 5,
      agentsCompleted: 2,
      recommendationsCreated: 2,
      duplicatesSkipped: 0,
      usage: { calls: 2, inputTokens: 1_800, outputTokens: 440, costMicros: 374 },
      startedAt: new Date(Date.now() - 3_600_000),
      finishedAt: new Date(Date.now() - 3_540_000),
    });
    const recs: (typeof recommendations.$inferInsert)[] = [
      {
        storeId,
        fingerprint: createHash("sha256").update("ov-1").digest("hex"),
        type: "RECOVER_ABANDONED_CART",
        agentId: "REVENUE_RECOVERY",
        ruleId: "cart.abandoned-recovery",
        title: "Open high",
        description: "d",
        reasoning: ["a", "b"],
        priority: "HIGH",
        confidence: 88,
        riskLevel: "LOW",
        estimatedRevenueCents: 1_000,
        estimatedCostCents: 100,
        subjects: {},
        actionType: "SEND_RECOVERY_EMAIL",
        actionParams: {},
        status: RecommendationStatus.PendingApproval,
      },
      {
        storeId,
        fingerprint: createHash("sha256").update("ov-2").digest("hex"),
        type: "RESTOCK",
        agentId: "INVENTORY",
        ruleId: "inventory.stockout-risk",
        title: "Executed advisory",
        description: "d",
        reasoning: ["a", "b"],
        priority: "MEDIUM",
        confidence: 74,
        riskLevel: "MEDIUM",
        estimatedRevenueCents: 2_000,
        estimatedCostCents: 0,
        subjects: {},
        actionType: "ADVISORY",
        actionParams: {},
        status: RecommendationStatus.Measured,
      },
    ];
    const inserted = await tx.insert(recommendations).values(recs).returning({ id: recommendations.id });
    const [openRec, measuredRec] = inserted;
    await tx.insert(recommendationEvents).values([
      {
        storeId,
        recommendationId: openRec!.id,
        event: RecommendationEventType.Created,
        actorType: EventActorType.Ai,
        toStatus: RecommendationStatus.PendingApproval,
        details: {},
      },
      {
        storeId,
        recommendationId: measuredRec!.id,
        event: RecommendationEventType.Measured,
        actorType: EventActorType.System,
        details: { attributedRevenueCents: 7_200 },
      },
    ]);
    await tx.insert(recommendationOutcomes).values({
      storeId,
      recommendationId: measuredRec!.id,
      method: "CHECKOUT_TOKEN",
      windowDays: 14,
      attributedOrdersCount: 2,
      attributedRevenueCents: 7_200,
      linkage: { orderIds: ["00000000-0000-0000-0000-000000000001"], matchedBy: "CHECKOUT_TOKEN" },
      measuredAt: new Date(),
    });
    await tx.insert(actionExecutions).values({
      storeId,
      recommendationId: openRec!.id,
      actionType: "SEND_RECOVERY_EMAIL",
      status: "PENDING",
      idempotencyKey: createHash("sha256").update(randomUUID()).digest("hex"),
      actionPreview: { template: "RECOVERY" },
    });
  });
});

afterAll(async () => {
  await testDb.close();
});

describe("AiOverviewService.overview", () => {
  it("aggregates engine, health, open pipeline and outcomes", async () => {
    const overview = await new AiOverviewService(testDb.db).overview(storeId);
    expect(overview.engine.lastRunStatus).toBe("COMPLETED");
    expect(overview.engine.runsLast7d).toBe(1);
    expect(overview.engine.costMicrosLast7d).toBe(374);
    expect(overview.engine.tokensLast7d).toBe(2_240);
    expect(overview.health.score).toBe(71);
    expect(overview.open.pendingApproval).toBe(1);
    expect(overview.open.highPriorityOpen).toBe(1);
    expect(overview.outcomes.attributedRevenueCents).toBe(7_200);
    expect(overview.outcomes.attributedOrders).toBe(2);
    expect(overview.recentEvents.length).toBeGreaterThanOrEqual(2);
    expect(overview.recentEvents[0]!.title).toBeDefined();
  });
});

describe("AiOverviewService.automationOverview", () => {
  it("parses merchant policy and lists the execution ledger", async () => {
    const overview = await new AiOverviewService(testDb.db).automationOverview(storeId);
    expect(overview.policy.mode).toBe("SEMI_AUTOMATIC");
    expect(overview.policy.abandonedCartDelayHours).toBe(8);
    expect(overview.policy.abandonedCartDiscountPercent).toBe(15);
    expect(overview.executions).toHaveLength(1);
    expect(overview.executions[0]!.recommendationTitle).toBe("Open high");
    expect(overview.outcomes.measuredCount).toBe(1);
    expect(overview.outcomes.attributedRevenueCents).toBe(7_200);
  });
});

describe("zero state (new store, no AI run yet)", () => {
  it("returns typed nulls — the UI renders a first-run CTA, not a crash", async () => {
    const emptyStore = await seedStore(testDb.db, { shopDomain: "overview-empty.myshopify.com" });
    const overview = await new AiOverviewService(testDb.db).overview(emptyStore);
    expect(overview.engine.lastRunAt).toBeNull();
    expect(overview.engine.lastRunStatus).toBeNull();
    expect(overview.engine.lastRunTrigger).toBeNull();
    expect(overview.engine.runsLast7d).toBe(0);
    expect(overview.engine.costMicrosLast7d).toBe(0);
    expect(overview.health.score).toBeNull();
    expect(overview.health.components).toBeNull();
    expect(overview.open.pendingApproval).toBe(0);
    expect(overview.open.executing).toBe(0);
    expect(overview.outcomes.acceptanceRatePct).toBeNull();
    expect(overview.outcomes.attributedRevenueCents).toBe(0);
    expect(overview.recentEvents).toEqual([]);

    const automation = await new AiOverviewService(testDb.db).automationOverview(emptyStore);
    expect(automation.executions).toEqual([]);
    expect(automation.outcomes.measuredCount).toBe(0);
    expect(automation.outcomes.attributedRevenueCents).toBe(0);
  });
});
