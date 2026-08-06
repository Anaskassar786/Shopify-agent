import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiCallLogs, recommendationOutcomes, recommendations } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  AiAgentId,
  AiCallStatus,
  AiProviderId,
  AttributionMethod,
  ModelTier,
  Priority,
  RecommendationStatus,
  UserStatus,
} from "@profit/types";
import { users } from "@profit/db";
import { ROI_WINDOWS_DAYS, RoiReportService } from "./roi";
import { bootAiTestDb, seedStore } from "../test-support/integration";

/**
 * ROI reporting contract (P11): measured attribution + deterministic pipeline
 * + honest AI cost, windowed exactly, zero-cost ROI never Infinity.
 */

const DAY = 24 * 3_600_000;
const NOW = new Date("2026-08-06T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

let testDb: TestDatabase;
let storeId = "";
const service = () => new RoiReportService(testDb.db);

async function recommendation(input: {
  status: RecommendationStatus;
  estimatedRevenueCents?: number;
  priority?: Priority;
  decidedAt?: Date | null;
}): Promise<string> {
  let decidedByUserId: string | null = null;
  if (input.status === RecommendationStatus.Approved || input.status === RecommendationStatus.Rejected) {
    const userRows = await testDb.db
      .insert(users)
      .values({ email: `roi-${randomUUID().slice(0, 8)}@example.test`, fullName: "Roi Owner", status: UserStatus.Active })
      .returning();
    decidedByUserId = userRows[0]!.id;
  }
  const rows = await testDb.db
    .insert(recommendations)
    .values({
      storeId,
      fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      type: "RECOVER_ABANDONED_CART",
      agentId: "REVENUE_RECOVERY",
      ruleId: "cart.abandoned-recovery",
      title: "Recover recent abandoned carts",
      description: "High-value carts went cold in the measurement window.",
      reasoning: ["point one", "point two"],
      priority: input.priority ?? Priority.Medium,
      confidence: 78,
      riskLevel: "LOW",
      estimatedRevenueCents: input.estimatedRevenueCents ?? 10_000,
      estimatedCostCents: 900,
      subjects: { checkoutTokens: ["t"] },
      actionType: "SEND_RECOVERY_EMAIL",
      actionParams: {},
      status: input.status,
      expiresAt: new Date(NOW.getTime() + 7 * DAY),
      ...(input.decidedAt !== undefined && input.decidedAt !== null
        ? { decidedAt: input.decidedAt, decidedByUserId }
        : {}),
    })
    .returning({ id: recommendations.id });
  return rows[0]!.id;
}

async function aiCall(input: { createdAt: Date; costMicros: number; status?: AiCallStatus }): Promise<void> {
  await testDb.db.insert(aiCallLogs).values({
    storeId,
    agentId: AiAgentId.RevenueRecovery,
    provider: AiProviderId.Gemini,
    model: "gemini-2.5-pro",
    modelTier: ModelTier.Standard,
    promptId: "recovery.plan",
    promptVersion: "1",
    status: input.status ?? AiCallStatus.Succeeded,
    inputTokens: 100,
    outputTokens: 60,
    costMicros: input.costMicros,
    latencyMs: 700,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

beforeAll(async () => {
  testDb = await bootAiTestDb();
  storeId = await seedStore(testDb.db, { shopDomain: "roi-report.myshopify.com" });

  // ── outcomes: two measured inside 30d, one measured 60d ago (90d window only) ──
  const recA = await recommendation({ status: RecommendationStatus.Measured, decidedAt: ago(20 * DAY) });
  const recB = await recommendation({ status: RecommendationStatus.Measured, decidedAt: ago(25 * DAY) });
  const recOld = await recommendation({ status: RecommendationStatus.Measured, decidedAt: ago(70 * DAY) });
  await testDb.db.insert(recommendationOutcomes).values([
    {
      storeId,
      recommendationId: recA,
      method: AttributionMethod.CheckoutToken,
      windowDays: 14,
      attributedOrdersCount: 2,
      attributedRevenueCents: 30_000,
      measuredAt: ago(10 * DAY),
    },
    {
      storeId,
      recommendationId: recB,
      method: AttributionMethod.DiscountCode,
      windowDays: 14,
      attributedOrdersCount: 0,
      attributedRevenueCents: 0, // measured but no lift — counts as MEASURED zero, not revenue
      measuredAt: ago(12 * DAY),
    },
    {
      storeId,
      recommendationId: recOld,
      method: AttributionMethod.CustomerWindow,
      windowDays: 14,
      attributedOrdersCount: 1,
      attributedRevenueCents: 8_000,
      measuredAt: ago(60 * DAY),
    },
  ]);

  // ── live pipeline (open statuses only) ──
  await recommendation({ status: RecommendationStatus.PendingApproval, estimatedRevenueCents: 50_000, priority: Priority.Critical });
  await recommendation({ status: RecommendationStatus.Approved, estimatedRevenueCents: 20_000, priority: Priority.High, decidedAt: ago(2 * DAY) });
  await recommendation({ status: RecommendationStatus.Rejected, estimatedRevenueCents: 9_000, decidedAt: ago(3 * DAY) });
  await recommendation({ status: RecommendationStatus.Executing, estimatedRevenueCents: 5_000, priority: Priority.Low });

  // ── AI cost: succeeded inside window (failed + old excluded) ──
  await aiCall({ createdAt: ago(5 * DAY), costMicros: 5_000 });
  await aiCall({ createdAt: ago(6 * DAY), costMicros: 5_000 });
  await aiCall({ createdAt: ago(6 * DAY), costMicros: 9_999, status: AiCallStatus.Failed });
  await aiCall({ createdAt: ago(40 * DAY), costMicros: 7_777 });
});

afterAll(async () => {
  await testDb.close();
});

describe("RoiReportService.report", () => {
  it("30-day window: measured attribution, open pipeline, honest cost, bounded ROI", async () => {
    const report = await service().report(storeId, 30, NOW);
    expect(report.windowDays).toBe(30);
    expect(report.outcomes).toEqual({
      attributedRevenueCents: 30_000,
      attributedOrdersCount: 2,
      measuredRecommendations: 1, // the zero-lift outcome is measured but not counted (both figures 0)
    });
    expect(report.pipeline).toEqual({
      openRecommendations: 3,
      openEstimatedRevenueCents: 75_000,
      highPriorityOpen: 2,
    });
    expect(report.cost).toEqual({ micros: 10_000, calls: 2 });
    // 30_000c revenue vs 10_000 micros (= $0.01) → 30_000×1e6/10_000 = 3_000_000.0
    expect(report.roiMultiple).toBe(3_000_000);
    expect(report.acceptanceRatePct).toBe(50); // 1 approved / (1 approved + 1 rejected) in window
  });

  it("90-day window widens attribution and cost honestly", async () => {
    expect(ROI_WINDOWS_DAYS).toEqual([30, 90]);
    const report = await service().report(storeId, 90, NOW);
    expect(report.outcomes.attributedRevenueCents).toBe(38_000);
    expect(report.outcomes.attributedOrdersCount).toBe(3);
    expect(report.outcomes.measuredRecommendations).toBe(2);
    expect(report.cost.calls).toBe(3); // the 40-day-old succeeded call joins the window
  });

  it("ROI multiple is NULL when cost or revenue is zero — never Infinity", async () => {
    const freeStore = await seedStore(testDb.db, { shopDomain: "roi-empty.myshopify.com" });
    const empty = await service().report(freeStore, 30, NOW);
    expect(empty.roiMultiple).toBeNull();
    expect(empty.acceptanceRatePct).toBeNull();
    expect(empty.cost).toEqual({ micros: 0, calls: 0 });
    expect(empty.pipeline.openRecommendations).toBe(0);
  });

  it("window is [from, to) exactly — boundary measurement stays outside", async () => {
    const boundaryStore = await seedStore(testDb.db, { shopDomain: "roi-boundary.myshopify.com" });
    const rec = await recommendation({ status: RecommendationStatus.Measured });
    await testDb.db.insert(recommendationOutcomes).values({
      storeId: boundaryStore,
      recommendationId: rec,
      method: AttributionMethod.CheckoutToken,
      windowDays: 14,
      attributedOrdersCount: 1,
      attributedRevenueCents: 1_000,
      measuredAt: ago(31 * DAY), // just outside 30d
    });
    const report = await service().report(boundaryStore, 30, NOW);
    expect(report.outcomes.attributedRevenueCents).toBe(0);
    const wide = await service().report(boundaryStore, 90, NOW);
    expect(wide.outcomes.attributedRevenueCents).toBe(1_000);
  });
});
