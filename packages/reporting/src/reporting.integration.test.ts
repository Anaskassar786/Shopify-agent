import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfitDb } from "@profit/db";
import {
  dailyMetrics,
  notifications,
  productMetrics,
  revenueMetrics,
  shopifyProducts,
  stores,
  storeSettings,
} from "@profit/db";
import { createTestDatabase, type TestDatabase } from "@profit/db/testing";
import type { EmailSendInput, EmailSender } from "@profit/ai";
import { ForecastService } from "@profit/forecasting";
import { createLogger } from "@profit/logger";
import {
  ReportKind,
  ReportStatus,
  StoreStatus,
} from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportNotFoundError, ReportService } from "./service";

const here = dirname(fileURLToPath(import.meta.url));
/** Saturday 2026-08-08 — weekly closes Jul 27→Aug 3, monthly closes Jul 1→Aug 1. */
const NOW = new Date("2026-08-08T09:00:00.000Z");

let testDb: TestDatabase;
let db: ProfitDb;
let storeA: string;
let storeB: string;

class FakeSender implements EmailSender {
  readonly sent: EmailSendInput[] = [];
  async send(input: EmailSendInput): Promise<{ messageId: string | null }> {
    this.sent.push(input);
    return { messageId: "msg-test" };
  }
}

class ExplodingForecast extends ForecastService {
  override storeForecast(): Promise<never> {
    return Promise.reject(new Error("forecast engine down"));
  }
}

function iso(daysBefore: number): string {
  return new Date(NOW.getTime() - daysBefore * 86_400_000).toISOString().slice(0, 10);
}

async function seedStore(domain: string, name: string, prefs: Record<string, unknown>): Promise<string> {
  const rows = await db
    .insert(stores)
    .values({ shopDomain: domain, name, status: StoreStatus.Active, email: `owner@${domain}` })
    .returning();
  const id = rows[0]!.id;
  await db.insert(storeSettings).values({
    storeId: id,
    aiPreferences: {},
    automationPreferences: {},
    featureOverrides: {},
    reportPreferences: prefs,
  });
  return id;
}

/** 45 days of flat metrics ending yesterday (both monthly + weekly have data). */
async function seedAnalytics(storeId: string): Promise<void> {
  await db.insert(revenueMetrics).values(
    Array.from({ length: 45 }, (_, i) => ({
      storeId,
      metricDate: iso(45 - i),
      netSalesCents: 10_000,
      grossSalesCents: 12_000,
      discountsCents: 500,
      refundsCents: 0,
    })),
  );
  await db.insert(dailyMetrics).values(
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
  const productRows = await db
    .insert(shopifyProducts)
    .values({ storeId, shopifyProductId: `${storeId}-p`, title: "Copper Kettle", status: "ACTIVE" })
    .returning();
  await db.insert(productMetrics).values(
    Array.from({ length: 45 }, (_, i) => ({
      storeId,
      productId: productRows[0]!.id,
      metricDate: iso(45 - i),
      unitsSold: 4,
      revenueCents: 8_000,
    })),
  );
}

function service(sender: EmailSender | null = null, forecast?: ForecastService): ReportService {
  return new ReportService({
    db,
    logger: createLogger({ level: "silent", service: "reporting-test", environment: "test" }),
    provider: null,
    emailSender: sender,
    forecastService: forecast,
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase(resolve(here, "../../db/drizzle"));
  db = testDb.db;
  storeA = await seedStore("reports-a.myshopify.com", "Reports A", {}); // defaults
  storeB = await seedStore("reports-b.myshopify.com", "Reports B", { kinds: { DAILY: true }, emailDelivery: false });
  await seedAnalytics(storeA);
}, 120_000);

afterAll(async () => {
  await testDb.close();
});

describe("ReportService.runDue (scheduled path)", () => {
  it("generates the default weekly + monthly reports with reconciled sections", async () => {
    const outcome = await service().runDue(storeA, NOW);
    expect(outcome.due).toEqual([ReportKind.Weekly, ReportKind.Monthly]);
    expect(outcome.generated).toHaveLength(2);
    expect(outcome.generated.every((r) => r.status === ReportStatus.Ready)).toBe(true);
    expect(outcome.emailedTo).toBeNull(); // emailDelivery disabled by default

    const list = await service().list(storeA, undefined);
    expect(list).toHaveLength(2);
    const weekly = list.find((row) => row.kind === ReportKind.Weekly)!;
    expect(weekly.status).toBe(ReportStatus.Ready);
    expect(weekly.periodLabel).toBe("Jul 27, 2026 – Aug 2, 2026");
    expect(weekly.pdfSizeBytes).toBeGreaterThan(500);

    const detail = await service().detail(storeA, weekly.id);
    const sections = detail.sections!;
    // Weekly net = 7 × $100.00 — dashboard and report read the same model.
    expect(sections.kpis.find((kpi) => kpi.label === "Net sales")!.display).toBe("$700.00");
    expect(sections.performance.rows).toHaveLength(7);
    expect(sections.topProducts!.rows[0]).toEqual(["Copper Kettle", "$560.00", "28", expect.stringContaining("%")]);
    expect(sections.forecast).not.toBeNull();
    expect(sections.forecast!.method).toBe("revenue.weekly-seasonality.v1");
    expect(detail.executiveSummary).toContain("Reports A");
  });

  it("is convergent: a second tick on the same day generates nothing", async () => {
    const second = await service().runDue(storeA, NOW);
    expect(second.due).toEqual([]);
    expect(second.generated).toHaveLength(0);
    expect(await service().list(storeA, undefined)).toHaveLength(2);
  });

  it("notify-once: repeated ticks never duplicate the readiness notice", async () => {
    const beforeCount = await db.select({ id: notifications.id }).from(notifications);
    // Two READY reports on the first tick produced exactly two notices; the
    // convergent second tick (previous test) must have added zero.
    expect(beforeCount).toHaveLength(2);
    const third = await service().runDue(storeA, NOW);
    expect(third.generated).toHaveLength(0);
    const afterCount = await db.select({ id: notifications.id }).from(notifications);
    expect(afterCount).toHaveLength(2);
  });

  it("serves the PDF bytes with a deterministic filename", async () => {
    const list = await service().list(storeA, ReportKind.Monthly);
    const pdf = await service().pdfFor(storeA, list[0]!.id);
    expect(pdf.bytes.slice(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(pdf.filename).toBe("reports-a-monthly-2026-07-01.pdf");
    expect(pdf.bytes.length).toBe(pdf.sizeBytes);
  });

  it("tenant isolation: B sees none of A's reports", async () => {
    expect(await service().list(storeB, undefined)).toHaveLength(0);
    await expect(service().detail(storeB, (await service().list(storeA, undefined))[0]!.id)).rejects.toThrow(ReportNotFoundError);
  });
});

describe("ReportService deliver + manual generate", () => {
  it("manual generation covers a due daily kind when enabled in preferences", async () => {
    const outcome = await service().runDue(storeB, NOW);
    expect(outcome.due).toEqual([ReportKind.Daily, ReportKind.Weekly, ReportKind.Monthly]);
    // B enabled daily only via prefs override + defaults (weekly/monthly defaults true).
    expect(outcome.generated.map((r) => r.kind)).toContain(ReportKind.Daily);
  });

  it("delivers by email once per UTC day (retry-safe), sender-null is first-class", async () => {
    const sender = new FakeSender();
    const svc = service(sender);
    const list = await svc.list(storeA, ReportKind.Weekly);
    const reportId = list[0]!.id;

    const first = await svc.deliver(storeA, reportId, "merchant@example.com", NOW);
    expect(first.sent).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe("merchant@example.com");
    expect(sender.sent[0]!.subject).toContain("weekly report");

    const again = await svc.deliver(storeA, reportId, "merchant@example.com", NOW);
    expect(again).toEqual({ sent: false, reason: "already-sent-today" });
    expect(sender.sent).toHaveLength(1);

    const nextDay = new Date(NOW.getTime() + 86_400_000);
    expect((await svc.deliver(storeA, reportId, "merchant@example.com", nextDay)).sent).toBe(true);

    const noSender = await service(null).deliver(storeA, reportId, "merchant@example.com", new Date(nextDay.getTime() + 86_400_000));
    expect(noSender).toEqual({ sent: false, reason: "email-unavailable" });
  });

  it("a failing dependency lands the row FAILED with the message preserved (tick continues)", async () => {
    const failing = new ExplodingForecast(db);
    const svc = service(null, failing);
    const outcome = await svc.generateForPeriod(
      storeA,
      ReportKind.Daily,
      { start: new Date("2026-08-06T00:00:00.000Z"), end: new Date("2026-08-07T00:00:00.000Z") },
      NOW,
    );
    expect(outcome.status).toBe(ReportStatus.Failed);
    expect(outcome.errorMessage).toBe("forecast engine down");
    const detail = await service().detail(storeA, outcome.reportId);
    expect(detail.status).toBe(ReportStatus.Failed);
    expect(detail.errorMessage).toBe("forecast engine down");
    // Failed periods stay "due" — the next healthy tick retries them.
    const prefs = await service().preferencesFor(storeA);
    expect(prefs.kinds[ReportKind.Daily]).toBe(false); // A has daily disabled → not retried by schedule
  });

  it("manual regenerate of the same period converges on ONE row", async () => {
    const svc = service();
    const period = { start: new Date("2026-08-05T00:00:00.000Z"), end: new Date("2026-08-06T00:00:00.000Z") };
    const first = await svc.generateForPeriod(storeA, ReportKind.Daily, period, NOW);
    const second = await svc.generateForPeriod(storeA, ReportKind.Daily, period, NOW);
    expect(second.reportId).toBe(first.reportId);
    const dailies = (await svc.list(storeA, ReportKind.Daily)).filter(
      (row) => row.periodLabel === "Aug 5, 2026",
    );
    expect(dailies).toHaveLength(1);
    expect(dailies[0]!.status).toBe(ReportStatus.Ready);
  });
});
