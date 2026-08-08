import { describe, expect, it } from "vitest";
import { ReportKind } from "@profit/types";
import {
  closedPeriodFor,
  periodIsoRange,
  periodLabel,
  periodLengthDays,
  priorPeriodFor,
} from "./periods";

/** Period math boundaries (UTC, end-exclusive, fully closed windows). */
describe("closedPeriodFor", () => {
  // Friday 2026-08-07 18:30Z ⇒ yesterday is Thu Aug 6.
  const friday = new Date("2026-08-07T18:30:00.000Z");
  // Saturday 2026-08-08 09:00Z.
  const saturday = new Date("2026-08-08T09:00:00.000Z");

  it("daily reports yesterday 00:00Z → today 00:00Z", () => {
    const period = closedPeriodFor(ReportKind.Daily, friday);
    expect(period.start.toISOString()).toBe("2026-08-06T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-08-07T00:00:00.000Z");
    expect(periodLengthDays(period)).toBe(1);
  });

  it("weekly reports the last ISO week (Mon→Mon), even on Saturday", () => {
    const period = closedPeriodFor(ReportKind.Weekly, saturday);
    expect(period.start.toISOString()).toBe("2026-07-27T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(periodLengthDays(period)).toBe(7);
  });

  it("weekly on a Monday reports the week that just closed", () => {
    const period = closedPeriodFor(ReportKind.Weekly, new Date("2026-08-03T05:00:00.000Z"));
    expect(period.start.toISOString()).toBe("2026-07-27T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  it("monthly reports the previous calendar month", () => {
    const period = closedPeriodFor(ReportKind.Monthly, saturday);
    expect(period.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(periodLengthDays(period)).toBe(31);
  });

  it("quarterly reports the previous quarter across year boundaries", () => {
    const q1 = closedPeriodFor(ReportKind.Quarterly, new Date("2026-01-15T00:00:00.000Z"));
    expect(q1.start.toISOString()).toBe("2025-10-01T00:00:00.000Z");
    expect(q1.end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const q3 = closedPeriodFor(ReportKind.Quarterly, saturday);
    expect(q3.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(q3.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("prior period is the equal-length window immediately before", () => {
    const monthly = closedPeriodFor(ReportKind.Monthly, saturday);
    const prior = priorPeriodFor(monthly);
    expect(prior.end.getTime()).toBe(monthly.start.getTime());
    expect(prior.end.getTime() - prior.start.getTime()).toBe(monthly.end.getTime() - monthly.start.getTime());
    expect(prior.start.toISOString()).toBe("2026-05-31T00:00:00.000Z");
  });

  it("labels are human and method-stable", () => {
    expect(periodLabel(ReportKind.Daily, closedPeriodFor(ReportKind.Daily, friday))).toBe("Aug 6, 2026");
    expect(periodLabel(ReportKind.Weekly, closedPeriodFor(ReportKind.Weekly, saturday))).toBe("Jul 27, 2026 – Aug 2, 2026");
    expect(periodLabel(ReportKind.Monthly, closedPeriodFor(ReportKind.Monthly, saturday))).toBe("Jul 2026");
    expect(periodLabel(ReportKind.Quarterly, closedPeriodFor(ReportKind.Quarterly, saturday))).toBe(
      "Q2 2026 (Apr 1, 2026 – Jun 30, 2026)",
    );
  });

  it("iso ranges are string-safe for metric_date comparisons", () => {
    const range = periodIsoRange(closedPeriodFor(ReportKind.Weekly, saturday));
    expect(range).toEqual({ from: "2026-07-27", toExclusive: "2026-08-03" });
  });
});
