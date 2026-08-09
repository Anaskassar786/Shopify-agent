import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engagementEvents, eq, users } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import { ENGAGEMENT_MILESTONE_KINDS, EngagementEventKind, UserStatus } from "@profit/types";
import { EngagementService } from "./engagement.service";
import { bootBillingTestDb, seedBillingStore, uniqueDomain } from "./test-support/integration";

/**
 * The partial unique index (migration 0006) is the dedupe authority; these
 * tests prove the ON CONFLICT predicate in emit() matches it EXACTLY against
 * real Postgres — and that repeatable kinds stay repeatable.
 */

let testDb: TestDatabase;
const service = () => new EngagementService(testDb.db);
const rowsFor = async (storeId: string) =>
  testDb.db.select().from(engagementEvents).where(eq(engagementEvents.storeId, storeId));

beforeAll(async () => {
  testDb = await bootBillingTestDb();
});

afterAll(async () => {
  await testDb.close();
});

describe("emit — milestone dedupe", () => {
  it("first fire records, re-fires are a free no-op, for EVERY milestone kind", async () => {
    expect(ENGAGEMENT_MILESTONE_KINDS.length).toBeGreaterThanOrEqual(7);
    for (const kind of ENGAGEMENT_MILESTONE_KINDS) {
      const storeId = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain(`dedupe-${kind.toLowerCase()}`) });
      expect(await service().emit({ storeId, kind })).toBe(true);
      expect(await service().emit({ storeId, kind })).toBe(false);
      expect(await rowsFor(storeId)).toHaveLength(1);
    }
  });

  it("repeatable kinds (upgrade views, churn nudges) never dedupe", async () => {
    const storeId = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("repeat") });
    expect(await service().emit({ storeId, kind: EngagementEventKind.UpgradeViewed })).toBe(true);
    expect(await service().emit({ storeId, kind: EngagementEventKind.UpgradeViewed })).toBe(true);
    expect(await service().emit({ storeId, kind: EngagementEventKind.ChurnNudgeSent })).toBe(true);
    expect(await rowsFor(storeId)).toHaveLength(3);
  });

  it("persists user + metadata context", async () => {
    const storeId = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("meta") });
    const userRows = await testDb.db
      .insert(users)
      .values({ email: "engager@example.test", fullName: "Eng", status: UserStatus.Active })
      .returning();
    await service().emit({
      storeId,
      kind: EngagementEventKind.FirstAiInsightViewed,
      userId: userRows[0]!.id,
      metadata: { surface: "command-center" },
    });
    const rows = await rowsFor(storeId);
    expect(rows[0]!.userId).toBe(userRows[0]!.id);
    expect((rows[0]!.metadata as Record<string, unknown>)["surface"]).toBe("command-center");
  });
});

describe("lastActivityAt + recentEvents", () => {
  it("returns null without events and the freshest timestamp after", async () => {
    const storeId = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("activity") });
    expect(await service().lastActivityAt(storeId)).toBeNull();
    await service().emit({ storeId, kind: EngagementEventKind.StoreConnected });
    await service().emit({ storeId, kind: EngagementEventKind.UpgradeViewed });
    const last = await service().lastActivityAt(storeId);
    expect(last).not.toBeNull();

    const recent = await service().recentEvents(storeId);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(recent[1]!.createdAt.getTime());
    expect((await service().recentEvents(storeId, 1)).length).toBe(1);
  });
});

describe("funnel — ordered milestone counts with conversion", () => {
  it("computes store counts and step conversion honestly", async () => {
    // Fresh funnel stores own this test (milestones are global to the DB —
    // count DELTAS against a baseline snapshot).
    const baseline = new Map((await service().funnel()).map((row) => [row.kind, row.stores]));

    const progressing = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("funnel-1") });
    const stalled = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("funnel-2") });
    for (const storeId of [progressing, stalled]) {
      await service().emit({ storeId, kind: EngagementEventKind.StoreConnected });
    }
    await service().emit({ storeId: progressing, kind: EngagementEventKind.FirstSyncCompleted });
    await service().emit({ storeId: progressing, kind: EngagementEventKind.FirstAiInsightViewed });

    const funnel = await service().funnel();
    expect(funnel.map((row) => row.kind)).toEqual([...ENGAGEMENT_MILESTONE_KINDS]);
    const byKind = new Map(funnel.map((row) => [row.kind, row]));
    expect(byKind.get(EngagementEventKind.StoreConnected)!.stores).toBe(
      (baseline.get(EngagementEventKind.StoreConnected) ?? 0) + 2,
    );
    expect(byKind.get(EngagementEventKind.FirstSyncCompleted)!.stores).toBe(
      (baseline.get(EngagementEventKind.FirstSyncCompleted) ?? 0) + 1,
    );
    // first step has no predecessor
    expect(funnel[0]!.conversionFromPreviousPct).toBeNull();
    const syncStep = byKind.get(EngagementEventKind.FirstSyncCompleted)!;
    const connected = (baseline.get(EngagementEventKind.StoreConnected) ?? 0) + 2;
    const synced = (baseline.get(EngagementEventKind.FirstSyncCompleted) ?? 0) + 1;
    expect(syncStep.conversionFromPreviousPct).toBe(Math.round((synced / connected) * 1000) / 10);
  });
});
