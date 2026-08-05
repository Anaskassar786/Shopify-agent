import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "@profit/db";
import { backgroundJobs, dailyMetrics } from "@profit/db";
import {
  AnalyticsNightlyTickJob,
  AnalyticsRefreshJob,
  MaintenanceDailyTickJob,
} from "@profit/sync";
import {
  buildWorkerTestEnvironment,
  jsonResponse,
  type WorkerTestEnvironment,
} from "../test-support/harness";

let env: WorkerTestEnvironment;

beforeEach(async () => {
  env = await buildWorkerTestEnvironment();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.close();
});

describe("analytics + maintenance tick handlers", () => {
  it("analytics.refresh recomputes aggregates idempotently and bumps the cache domain", async () => {
    await env.queue.enqueue(AnalyticsRefreshJob, { storeId: env.storeId });
    await env.settle();
    expect(await env.cacheVersion("analytics")).toBe(1);
    // Empty store → zero rows, but a SECOND run proves idempotent safety.
    await env.queue.enqueue(AnalyticsRefreshJob, { storeId: env.storeId });
    await env.settle();
    expect((await env.db.select().from(dailyMetrics)).length).toBe(0);
    expect(await env.cacheVersion("analytics")).toBe(2);
  });

  it("analytics.refresh honors a date window payload", async () => {
    await env.queue.enqueue(AnalyticsRefreshJob, {
      storeId: env.storeId,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-03",
    });
    await env.settle();
    expect(await env.cacheVersion("analytics")).toBe(1);
  });

  it("analytics.nightly-tick fans out one persisted refresh per active store", async () => {
    await env.queue.enqueue(AnalyticsNightlyTickJob, {});
    await env.settle();
    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.jobType, "analytics.refresh"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.storeId).toBe(env.storeId);
    expect(jobs[0]?.status).toBe("COMPLETED");
  });

  it("maintenance.daily-tick enqueues webhook reconciliation + full syncs for windowless modules", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { query?: string }) : {};
      if (body.query?.includes("WebhookSubscriptions")) {
        return jsonResponse({ data: { webhookSubscriptions: { nodes: [] } } });
      }
      if (body.query?.includes("webhookSubscriptionCreate")) {
        return jsonResponse({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: "gid://shopify/WebhookSubscription/1", topic: "PRODUCTS_CREATE" },
              userErrors: [],
            },
          },
        });
      }
      if (url.includes("/locations.json")) return jsonResponse({ locations: [{ id: 1, name: "HQ", active: true }] });
      if (url.includes("/inventory_levels.json")) return jsonResponse({ inventory_levels: [] });
      if (url.includes("/metafields.json")) return jsonResponse({ metafields: [] });
      if (url.includes("/graphql.json")) {
        return jsonResponse({
          data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }
      return jsonResponse({ errors: `unstubbed ${url}` }, { status: 500 });
    }));
    await env.queue.enqueue(MaintenanceDailyTickJob, {});
    await env.settle();
    const enqueued = await env.db
      .select()
      .from(backgroundJobs)
      .where(
        inArray(backgroundJobs.jobType, [
          "shopify.webhooks.ensure",
          "sync.module",
        ]),
      );
    const types = enqueued.map((job) => job.jobType).sort();
    expect(types).toEqual(["shopify.webhooks.ensure", "sync.module", "sync.module"]);
    // Both module jobs are the daily FULL passes (inventory + metafields).
    const modules = enqueued
      .filter((job) => job.jobType === "sync.module")
      .map((job) => (job.payload as { module: string }).module)
      .sort();
    expect(modules).toEqual(["INVENTORY", "METAFIELDS"]);
    expect(enqueued.every((job) => job.status === "COMPLETED")).toBe(true);
  });
});
