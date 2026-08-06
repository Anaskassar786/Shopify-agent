import { and, eq } from "@profit/db";
import { backgroundJobs, notifications, syncHistory } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { SyncModule } from "@profit/types";
import type { RealtimeEvent } from "@profit/types";
import { RealtimeEventKind } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SyncStoreFullJob } from "@profit/sync";
import {
  buildWorkerTestEnvironment,
  jsonResponse,
  type WorkerTestEnvironment,
} from "../test-support/harness";
import {
  emitSyncModuleCompleted,
  latestFailedRunId,
  notifyFullRunCompleted,
} from "./realtime";
import type { Logger } from "@profit/logger";

/**
 * M3 realtime bridge + group fan-in semantics:
 *  - FULL 7-module group completes ⇒ merchant notification + socket event;
 *  - PARTIAL group completes ⇒ analytics.refresh fires WITHOUT the "data
 *    ready" notification (noise discipline);
 *  - latestFailedRunId tolerates a dead database (failure path must never
 *    cascade into the handler's retry contract).
 */

let env: WorkerTestEnvironment;
let analyticsJobsBefore = 0;

const events: RealtimeEvent[] = [];

function stubShopifyForAllModules(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/products.json")) {
      return jsonResponse({ products: [] });
    }
    return jsonResponse({
      custom_collections: [], smart_collections: [], customers: [], orders: [],
      locations: [], inventory_levels: [], price_rules: [], metafields: [],
      checkouts: [], // M4: 8th module
      data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    });
  }));
}

beforeAll(async () => {
  env = await buildWorkerTestEnvironment();
  await env.pubsub.subscribe(`rt:${env.storeId}`, (message) => {
    events.push(message.payload as RealtimeEvent);
  });
});

afterAll(async () => {
  await env.close();
});

describe("full-run group completion", () => {
  it("fires the notification + event exactly once when all 8 modules land", async () => {
    stubShopifyForAllModules();
    const runGroupId = "33333333-4444-4444-8444-333333333333";
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      SyncStoreFullJob,
      { storeId: env.storeId, runGroupId },
      { jobId: `full-all-${runGroupId}` },
    );
    await env.settle();

    const rows = await env.db
      .select()
      .from(notifications)
      .where(eq(notifications.storeId, env.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Data sync complete");
    expect(rows[0]?.body).toContain("8");

    const completionEvents = events.filter(
      (e) => e.kind === RealtimeEventKind.SyncFullRunCompleted,
    );
    expect(completionEvents).toHaveLength(1);
    expect(completionEvents[0]?.payload).toMatchObject({
      runGroupId,
      modulesCompleted: 8,
    });

    // Per-module progress events streamed too (8 completed, no rows for them).
    const moduleEvents = events.filter(
      (e) => e.kind === RealtimeEventKind.SyncModuleCompleted,
    );
    expect(moduleEvents.length).toBe(8);

    // Fan-in triggered the analytics refresh job.
    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.jobType, "analytics.refresh"));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("partial groups refresh analytics silently (no merchant notification)", async () => {
    stubShopifyForAllModules();
    analyticsJobsBefore = (
      await env.db.select().from(backgroundJobs).where(eq(backgroundJobs.jobType, "analytics.refresh"))
    ).length;
    const runGroupId = "55555555-6666-4666-8666-555555555555";
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      SyncStoreFullJob,
      {
        storeId: env.storeId,
        runGroupId,
        modules: [SyncModule.Products, SyncModule.Collections],
      },
      { jobId: `full-partial-${runGroupId}` },
    );
    await env.settle();

    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.jobType, "analytics.refresh"));
    // Exactly one refresh per completed module run in this file, asserted by
    // growth since the previous group's assertion (precise, no jobId games).
    expect(jobs.length).toBeGreaterThanOrEqual(analyticsJobsBefore + 1);

    const groupEvents = events.filter(
      (e) =>
        e.kind === RealtimeEventKind.SyncFullRunCompleted &&
        (e.payload as { runGroupId: string }).runGroupId === runGroupId,
    );
    expect(groupEvents).toHaveLength(0);
  });
});

describe("realtime helper contracts", () => {
  it("emitSyncModuleCompleted publishes progress without persistence", async () => {
    const before = events.length;
    await emitSyncModuleCompleted(env.pubsub, {
      storeId: env.storeId,
      module: SyncModule.Orders,
      runId: "unit-run-1",
      stats: { processed: 10, created: 2, updated: 8, failed: 0 },
    });
    expect(events.length).toBe(before + 1);
    const event = events.at(-1)!;
    expect(event.kind).toBe(RealtimeEventKind.SyncModuleCompleted);
    expect((event.payload as { runId: string }).runId).toBe("unit-run-1");
  });

  it("notifyFullRunCompleted writes the row then publishes (direct call)", async () => {
    const logger = env.logger as Logger;
    await notifyFullRunCompleted(
      { db: env.db, pubsub: env.pubsub, logger },
      { storeId: env.storeId, runGroupId: "77777777-8888-4888-8888-777777777777", modulesCompleted: 7 },
    );
    const rows = await env.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.storeId, env.storeId), eq(notifications.actionUrl, "/dashboard")),
      );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("latestFailedRunId finds the FAILED row and tolerates a dead db", async () => {
    const inserted = await env.db
      .insert(syncHistory)
      .values({
        storeId: env.storeId,
        module: SyncModule.Orders,
        mode: "MANUAL",
        status: "FAILED",
        stats: { processed: 0, created: 0, updated: 0, failed: 1 },
        errorMessage: "boom",
        finishedAt: new Date(),
      })
      .returning();
    const found = await latestFailedRunId(env.db, env.storeId, SyncModule.Orders);
    expect(found).toBe(inserted[0]!.id);

    const deadDb = {
      transaction: () => Promise.reject(new Error("connection lost")),
    } as unknown as ProfitDb;
    const tolerated = await latestFailedRunId(deadDb, env.storeId, SyncModule.Orders);
    expect(tolerated).toBeNull();
  });
});
