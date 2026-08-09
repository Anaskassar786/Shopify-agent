import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "@profit/db";
import {
  auditLogs,
  backgroundJobs,
  dailyMetrics,
  reports,
  revenueMetrics,
  storeSettings,
} from "@profit/db";
import { ReportsGenerateJob, ReportsTickJob } from "@profit/reporting";
import { ReportKind, ReportStatus } from "@profit/types";
import {
  buildWorkerTestEnvironment,
  seedHarnessSubscription,
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

type AnyDb = WorkerTestEnvironment["db"];

/** Flat 45 days of metrics so weekly + monthly closed periods carry data. */
async function seedAnalytics45(target: AnyDb, storeId: string): Promise<void> {
  const iso = (daysBefore: number): string =>
    new Date(Date.now() - daysBefore * 86_400_000).toISOString().slice(0, 10);
  await target.insert(revenueMetrics).values(
    Array.from({ length: 45 }, (_, i) => ({
      storeId,
      metricDate: iso(45 - i),
      netSalesCents: 10_000,
      grossSalesCents: 12_000,
      discountsCents: 500,
      refundsCents: 0,
    })),
  );
  await target.insert(dailyMetrics).values(
    Array.from({ length: 45 }, (_, i) => ({
      storeId,
      metricDate: iso(45 - i),
      ordersCount: 4,
      cancelledOrders: 0,
      itemsSold: 8,
      newCustomers: 1,
      returningCustomers: 1,
      aovCents: 2_500,
    })),
  );
}

async function seedReportSettings(target: AnyDb, storeId: string, prefs: Record<string, unknown>): Promise<void> {
  await target.insert(storeSettings).values({
    storeId,
    aiPreferences: {},
    automationPreferences: {},
    featureOverrides: {},
    reportPreferences: prefs,
  });
}

describe("reports tick + generate pipeline (M8, ADR 34)", () => {
  it("reports.tick fans out one persisted generate job per active store", async () => {
    await env.queue.enqueue(ReportsTickJob, {});
    await env.settle();
    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.jobType, "reports.generate"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.storeId).toBe(env.storeId);
    // The leaf converges: default schedule produces weekly + monthly rows.
    const rows = await env.db.select().from(reports).where(eq(reports.storeId, env.storeId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.kind).sort()).toEqual([ReportKind.Monthly, ReportKind.Weekly].sort());
    expect(rows.every((row) => row.status === ReportStatus.Ready)).toBe(true);
    expect(rows.every((row) => (row.pdfSizeBytes ?? 0) > 500)).toBe(true);

    const audit = await env.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "reports.due_generated"));
    expect(audit).toHaveLength(1);
  });

  it("a repeated tick generates nothing new (day-stable jobId + period convergence)", async () => {
    await seedAnalytics45(env.db, env.storeId);
    await env.queue.enqueue(ReportsTickJob, {});
    await env.settle();
    await env.queue.enqueue(ReportsTickJob, {});
    await env.settle();
    const jobs = await env.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.jobType, "reports.generate"));
    expect(jobs).toHaveLength(1); // same jobId — the second enqueue dedupes
    const rows = await env.db.select().from(reports).where(eq(reports.storeId, env.storeId));
    expect(rows).toHaveLength(2);
  });

  it("merchant schedule drives the cadence set (daily enabled, weekly/monthly off)", async () => {
    await seedReportSettings(env.db, env.storeId, {
      kinds: { DAILY: true, WEEKLY: false, MONTHLY: false },
      emailDelivery: false,
    });
    await env.queue.enqueue(ReportsGenerateJob, { storeId: env.storeId });
    await env.settle();
    const rows = await env.db.select().from(reports).where(eq(reports.storeId, env.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe(ReportKind.Daily);
  });

  it("email delivery fires when preferences enable it and SMTP exists", async () => {
    const sent: { to: string; subject: string }[] = [];
    const custom = await buildWorkerTestEnvironment({
      emailSender: {
        async send(input) {
          sent.push({ to: input.to, subject: input.subject });
          return { messageId: "msg-1" };
        },
      },
    });
    try {
      await seedReportSettings(custom.db, custom.storeId, {
        kinds: { WEEKLY: true, MONTHLY: false },
        emailDelivery: true,
        recipientEmail: "owner@worker-store.test",
      });
      await custom.queue.enqueue(ReportsGenerateJob, { storeId: custom.storeId });
      await custom.settle();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe("owner@worker-store.test");
      expect(sent[0]!.subject).toContain("weekly report");
      const rows = await custom.db.select().from(reports).where(eq(reports.storeId, custom.storeId));
      expect(rows[0]?.lastEmailedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      await custom.close();
    }
  });

  it("manual re-generate honors the harness subscription gate path (no plan gating for reports)", async () => {
    // Reports are not a revenue action — even without a subscription row the
    // generation path runs (schedule + cadence are merchant data).
    await seedAnalytics45(env.db, env.storeId);
    await env.queue.enqueue(ReportsGenerateJob, { storeId: env.storeId });
    await env.settle();
    const rows = await env.db.select().from(reports).where(eq(reports.storeId, env.storeId));
    expect(rows.length).toBeGreaterThan(0);
    // And a store WITH a subscription behaves identically (parity guard).
    await seedHarnessSubscription(env.db, env.storeId);
    await env.queue.enqueue(ReportsTickJob, {});
    await env.settle();
    expect((await env.db.select().from(reports).where(eq(reports.storeId, env.storeId))).length).toBe(2);
  });
});
