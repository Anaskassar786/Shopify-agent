import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@profit/db";
import {
  actionExecutions,
  recommendations,
  recommendationEvents,
  users,
  withStoreScope,
} from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import { RecommendationStatus, UserStatus } from "@profit/types";
import {
  InvalidTransitionError,
  RecommendationNotFoundError,
  RecommendationService,
  listFiltersSchema,
} from "./recommendations";
import { AttributionService, MEASUREMENT_WINDOW_DAYS } from "./attribution";
import { bootAiTestDb, seedCustomers, seedStore } from "../test-support/integration";
import { shopifyOrders } from "@profit/db";
import { createHash } from "node:crypto";

/**
 * Approval state machine + attribution contract (PGlite + RLS): transitions
 * enforced, optimistic concurrency, advisory inline completion, measurement
 * windows, expiry sweep — all against real tables.
 */

let testDb: TestDatabase;
let storeId = "";
let userId = "";
const service = () => new RecommendationService(testDb.db);

function recInsert(overrides: Partial<typeof recommendations.$inferInsert> = {}) {
  return {
    storeId,
    fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
    type: "RECOVER_ABANDONED_CART",
    agentId: "REVENUE_RECOVERY",
    ruleId: "cart.abandoned-recovery",
    title: "Test recommendation",
    description: "A description long enough to be realistic",
    reasoning: ["point one", "point two"],
    priority: "HIGH",
    confidence: 80,
    riskLevel: "LOW",
    estimatedRevenueCents: 1_152,
    estimatedCostCents: 960,
    subjects: { checkoutTokens: ["t1"] },
    actionType: "SEND_RECOVERY_EMAIL",
    actionParams: { template: "RECOVERY", checkoutToken: "t1" },
    status: RecommendationStatus.PendingApproval,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    ...overrides,
  } satisfies typeof recommendations.$inferInsert;
}

async function insertRec(
  overrides: Partial<typeof recommendations.$inferInsert> = {},
): Promise<string> {
  const rows = await withStoreScope(testDb.db, storeId, async (tx) =>
    tx.insert(recommendations).values(recInsert(overrides)).returning({ id: recommendations.id }),
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  testDb = await bootAiTestDb();
  storeId = await seedStore(testDb.db, { shopDomain: "ai-state.myshopify.com" });
  const userRows = await testDb.db
    .insert(users)
    .values({ email: "owner@state.example", fullName: "Owner", status: UserStatus.Active })
    .returning();
  userId = userRows[0]!.id;
});

afterAll(async () => {
  await testDb.close();
});

describe("list + detail", () => {
  it("filters by status/priority and returns totals", async () => {
    const first = await insertRec({ title: "Alpha" });
    await insertRec({ title: "Beta", priority: "LOW", status: RecommendationStatus.Rejected });
    const all = await service().list(storeId, listFiltersSchema.parse({}));
    expect(all.total).toBeGreaterThanOrEqual(2);
    const high = await service().list(storeId, listFiltersSchema.parse({ priority: "HIGH" }));
    expect(high.rows.every((row) => row.priority === "HIGH")).toBe(true);
    const rejected = await service().list(
      storeId,
      listFiltersSchema.parse({ status: RecommendationStatus.Rejected }),
    );
    expect(rejected.rows.some((row) => row.title === "Beta")).toBe(true);

    const detail = await service().detail(storeId, first);
    expect(detail?.title).toBe("Alpha");
    expect(detail?.events).toEqual([]);
    expect(await service().detail(storeId, randomUUID())).toBeNull();
  });
});

describe("approve / reject transitions", () => {
  it("approve creates a PENDING execution + queued event for tool actions", async () => {
    const id = await insertRec();
    const { row, execution } = await service().approve(storeId, id, userId);
    expect(row.status).toBe(RecommendationStatus.Approved);
    expect(execution).not.toBeNull();

    const executions = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(actionExecutions).where(eq(actionExecutions.recommendationId, id)),
    );
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe("PENDING");
    expect(executions[0]!.idempotencyKey).toHaveLength(64);

    const events = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendationEvents).where(eq(recommendationEvents.recommendationId, id)),
    );
    expect(events.map((event) => event.event)).toEqual(["APPROVED", "EXECUTION_QUEUED"]);
  });

  it("advisory approvals complete inline to EXECUTED (no tool)", async () => {
    const id = await insertRec({
      type: "RESTOCK",
      actionType: "ADVISORY",
      actionParams: { note: "advisory.restock" },
      subjects: { productIds: ["p1"] },
    });
    const { row, execution } = await service().approve(storeId, id, userId);
    expect(row.status).toBe(RecommendationStatus.Executed);
    expect(execution).toBeNull();
  });

  it("reject records the learning reason", async () => {
    const id = await insertRec();
    const row = await service().reject(storeId, id, userId, "discounts hurt my margin");
    expect(row.status).toBe(RecommendationStatus.Rejected);
    expect(row.decisionReason).toBe("discounts hurt my margin");
  });

  it("double-approve is a typed invalid transition (state machine enforced)", async () => {
    const id = await insertRec();
    await service().approve(storeId, id, userId);
    await expect(service().approve(storeId, id, userId)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(service().reject(storeId, id, userId, "late")).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("missing rows throw NotFound (tenant-safe)", async () => {
    await expect(service().approve(storeId, randomUUID(), userId)).rejects.toBeInstanceOf(
      RecommendationNotFoundError,
    );
  });
});

describe("attribution (deterministic revenue linkage)", () => {
  it("CHECKOUT_TOKEN: order created from the recovered checkout attributes", async () => {
    const recId = await insertRec({
      status: RecommendationStatus.Executed,
      decidedAt: new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 5) * 86_400_000),
      expiresAt: null,
    });
    const finishedAt = new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 4) * 86_400_000);
    await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.insert(actionExecutions).values({
        storeId,
        recommendationId: recId,
        actionType: "SEND_RECOVERY_EMAIL",
        status: "SUCCEEDED",
        idempotencyKey: createHash("sha256").update(`${recId}|email`).digest("hex"),
        toolRef: { checkoutToken: "t1", sentTo: ["mia@example.com"] },
        startedAt: finishedAt,
        finishedAt,
      }),
    );
    // The recovered order: same checkout token.
    await testDb.db.insert(shopifyOrders).values({
      storeId,
      shopifyOrderId: `ord-${randomUUID().slice(0, 8)}`,
      name: "#5001",
      totalPrice: "96.00",
      checkoutToken: "t1",
      discountCodes: [],
      processedAt: new Date(Date.now() - 10 * 86_400_000),
      shopifyCreatedAt: new Date(Date.now() - 10 * 86_400_000),
    });

    const attribution = new AttributionService(testDb.db);
    const summary = await attribution.measureStore(storeId);
    expect(summary.measured).toBeGreaterThanOrEqual(1);

    const outcome = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendationEvents).where(eq(recommendationEvents.recommendationId, recId)),
    );
    expect(outcome.map((event) => event.event)).toContain("MEASURED");
    const rec = (
      await withStoreScope(testDb.db, storeId, async (tx) =>
        tx.select().from(recommendations).where(eq(recommendations.id, recId)))
    )[0]!;
    expect(rec.status).toBe(RecommendationStatus.Measured);

    const { recommendationOutcomes } = await import("@profit/db");
    const rows = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendationOutcomes).where(eq(recommendationOutcomes.recommendationId, recId)),
    );
    expect(rows[0]!.method).toBe("CHECKOUT_TOKEN");
    expect(rows[0]!.attributedRevenueCents).toBe(9_600);
    expect(rows[0]!.attributedOrdersCount).toBe(1);
  });

  it("CUSTOMER_WINDOW: batch-email orders inside the window attribute", async () => {
    const customers = await seedCustomers(testDb.db, storeId, [
      { shopifyId: "win-1", email: "lapsed@example.com", orders: 2, acceptsMarketing: true },
    ]);
    const customerId = customers.get("win-1")!;
    const recId = await insertRec({
      type: "WINBACK_INACTIVE",
      actionType: "SEND_RECOVERY_EMAIL",
      actionParams: { template: "WINBACK" },
      subjects: { customerIds: [customerId] },
      status: RecommendationStatus.Executed,
      decidedAt: new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 3) * 86_400_000),
      expiresAt: null,
    });
    const finishedAt = new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 2) * 86_400_000);
    await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.insert(actionExecutions).values({
        storeId,
        recommendationId: recId,
        actionType: "SEND_RECOVERY_EMAIL",
        status: "SUCCEEDED",
        idempotencyKey: createHash("sha256").update(`${recId}|win`).digest("hex"),
        toolRef: { sentTo: ["lapsed@example.com"] },
        startedAt: finishedAt,
        finishedAt,
      }),
    );
    await testDb.db.insert(shopifyOrders).values({
      storeId,
      shopifyOrderId: `ord-${randomUUID().slice(0, 8)}`,
      name: "#5002",
      totalPrice: "44.00",
      customerId,
      checkoutToken: null,
      discountCodes: [],
      processedAt: new Date(Date.now() - 4 * 86_400_000),
      shopifyCreatedAt: new Date(Date.now() - 4 * 86_400_000),
    });

    const attribution = new AttributionService(testDb.db);
    await attribution.measureStore(storeId);
    const { recommendationOutcomes } = await import("@profit/db");
    const rows = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendationOutcomes).where(eq(recommendationOutcomes.recommendationId, recId)),
    );
    expect(rows[0]!.method).toBe("CUSTOMER_WINDOW");
    expect(rows[0]!.attributedRevenueCents).toBe(4_400);
  });

  it("expiry sweep: stale open rows transition to EXPIRED with an audit event", async () => {
    const recId = await insertRec({
      title: "Expires",
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    const attribution = new AttributionService(testDb.db);
    const summary = await attribution.measureStore(storeId);
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    const rec = (
      await withStoreScope(testDb.db, storeId, async (tx) =>
        tx.select().from(recommendations).where(eq(recommendations.id, recId)))
    )[0]!;
    expect(rec.status).toBe(RecommendationStatus.Expired);
  });
});

describe("attribution edge cases (learning loop integrity)", () => {
  it("DISCOUNT_CODE fallback: an order using the issued code attributes when no checkout link exists", async () => {
    const recId = await insertRec({
      type: "REMOVE_DEAD_STOCK",
      actionType: "CREATE_DISCOUNT_CODE",
      actionParams: { purpose: "CLEARANCE", discountPercent: 25, expiresInDays: 14 },
      subjects: {},
      status: RecommendationStatus.Executed,
      decidedAt: new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 6) * 86_400_000),
      expiresAt: null,
    });
    const finishedAt = new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 5) * 86_400_000);
    await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.insert(actionExecutions).values({
        storeId,
        recommendationId: recId,
        actionType: "CREATE_DISCOUNT_CODE",
        status: "SUCCEEDED",
        idempotencyKey: createHash("sha256").update(`${recId}|disc`).digest("hex"),
        toolRef: { discountCode: "PT-CLEARTEST", priceRuleId: "9001" },
        startedAt: finishedAt,
        finishedAt,
      }),
    );
    await testDb.db.insert(shopifyOrders).values({
      storeId,
      shopifyOrderId: `ord-${randomUUID().slice(0, 8)}`,
      name: "#5003",
      totalPrice: "120.00",
      checkoutToken: null,
      discountCodes: [{ code: "PT-CLEARTEST" }],
      processedAt: new Date(Date.now() - 8 * 86_400_000),
      shopifyCreatedAt: new Date(Date.now() - 8 * 86_400_000),
    });

    await new AttributionService(testDb.db).measureStore(storeId);
    const { recommendationOutcomes } = await import("@profit/db");
    const rows = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendationOutcomes).where(eq(recommendationOutcomes.recommendationId, recId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("DISCOUNT_CODE");
    expect(rows[0]!.attributedRevenueCents).toBe(12_000);
  });

  it("re-measuring an already-measured recommendation is a no-op (idempotent sweep)", async () => {
    const recId = await insertRec({
      status: RecommendationStatus.Measured,
      decidedAt: new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 7) * 86_400_000),
      expiresAt: null,
    });
    // A measured rec never re-enters the sweep (status filter), but the outcome-exists
    // guard is the second fence — prove it with a direct measureOne-equivalent sweep after
    // forcing the status back to Executed WITH an outcome row present.
    const { recommendationOutcomes } = await import("@profit/db");
    await withStoreScope(testDb.db, storeId, async (tx) => {
      await tx.insert(recommendationOutcomes).values({
        storeId,
        recommendationId: recId,
        method: "DISCOUNT_CODE",
        windowDays: MEASUREMENT_WINDOW_DAYS,
        attributedOrdersCount: 1,
        attributedRevenueCents: 500,
        linkage: { orderIds: [], matchedBy: "DISCOUNT_CODE" },
        measuredAt: new Date(),
      });
      await tx
        .update(recommendations)
        .set({ status: RecommendationStatus.Executed })
        .where(eq(recommendations.id, recId));
    });
    const finishedAt = new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 6) * 86_400_000);
    await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.insert(actionExecutions).values({
        storeId,
        recommendationId: recId,
        actionType: "CREATE_DISCOUNT_CODE",
        status: "SUCCEEDED",
        idempotencyKey: createHash("sha256").update(`${recId}|idem`).digest("hex"),
        toolRef: { discountCode: "PT-IDEMPOTENT" },
        startedAt: finishedAt,
        finishedAt,
      }),
    );

    await new AttributionService(testDb.db).measureStore(storeId);
    const rows = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendationOutcomes).where(eq(recommendationOutcomes.recommendationId, recId)),
    );
    expect(rows).toHaveLength(1); // guarded — no second outcome row
  });

  it("EXECUTED with no successful execution stays unmeasured (failed actions never count as impact)", async () => {
    const recId = await insertRec({
      status: RecommendationStatus.Executed,
      decidedAt: new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 8) * 86_400_000),
      expiresAt: null,
    });
    const finishedAt = new Date(Date.now() - (MEASUREMENT_WINDOW_DAYS + 7) * 86_400_000);
    await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.insert(actionExecutions).values({
        storeId,
        recommendationId: recId,
        actionType: "SEND_RECOVERY_EMAIL",
        status: "FAILED",
        idempotencyKey: createHash("sha256").update(`${recId}|failed`).digest("hex"),
        errorMessage: "SMTP rejected",
        startedAt: finishedAt,
        finishedAt,
      }),
    );

    const before = await withStoreScope(testDb.db, storeId, async (tx) => {
      const { recommendationOutcomes } = await import("@profit/db");
      return tx.select().from(recommendationOutcomes).where(eq(recommendationOutcomes.recommendationId, recId));
    });
    await new AttributionService(testDb.db).measureStore(storeId);
    const after = await withStoreScope(testDb.db, storeId, async (tx) => {
      const { recommendationOutcomes } = await import("@profit/db");
      return tx.select().from(recommendationOutcomes).where(eq(recommendationOutcomes.recommendationId, recId));
    });
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(0);
    const rec = (
      await withStoreScope(testDb.db, storeId, async (tx) =>
        tx.select().from(recommendations).where(eq(recommendations.id, recId)))
    )[0]!;
    expect(rec.status).toBe(RecommendationStatus.Executed); // untouched
  });
});
