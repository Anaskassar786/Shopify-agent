import { describe, expect, it } from "vitest";
import { ReportKind } from "@profit/types";
import { closedPeriodFor, periodIsoRange } from "./periods";
import {
  DEFAULT_REPORT_PREFERENCES,
  dueKinds,
  parseReportPreferences,
  reportPreferencesSchema,
} from "./preferences";

const NOW = new Date("2026-08-08T09:00:00.000Z"); // Saturday

function iso(kind: (typeof ReportKind)[keyof typeof ReportKind]): string {
  return periodIsoRange(closedPeriodFor(kind, NOW)).from;
}

describe("parseReportPreferences", () => {
  it("defaults to weekly+monthly in-app when settings are empty or invalid", () => {
    for (const raw of [undefined, null, {}, "garbage", { kinds: { WEEKLY: "yes" } }]) {
      const prefs = parseReportPreferences(raw);
      expect(prefs.kinds[ReportKind.Weekly]).toBe(true);
      expect(prefs.kinds[ReportKind.Monthly]).toBe(true);
      expect(prefs.kinds[ReportKind.Daily]).toBe(false);
      expect(prefs.kinds[ReportKind.Quarterly]).toBe(false);
      expect(prefs.emailDelivery).toBe(false);
      expect(prefs.recipientEmail).toBeNull();
    }
  });

  it("honors merchant choices exactly", () => {
    const prefs = parseReportPreferences({
      kinds: { DAILY: true, WEEKLY: false },
      emailDelivery: true,
      recipientEmail: "owner@example.com",
    });
    expect(prefs.kinds[ReportKind.Daily]).toBe(true);
    expect(prefs.kinds[ReportKind.Weekly]).toBe(false);
    expect(prefs.kinds[ReportKind.Monthly]).toBe(true); // untouched default
    expect(prefs.emailDelivery).toBe(true);
    expect(prefs.recipientEmail).toBe("owner@example.com");
  });

  it("rejects malformed recipient emails at the schema boundary", () => {
    expect(reportPreferencesSchema.safeParse({ recipientEmail: "not-an-email" }).success).toBe(false);
    expect(reportPreferencesSchema.safeParse({ emailDelivery: "yes" }).success).toBe(false);
  });
});

describe("dueKinds (convergent schedule evaluation)", () => {
  it("every enabled kind with no history is due on the first tick", () => {
    expect(dueKinds(DEFAULT_REPORT_PREFERENCES, [], NOW)).toEqual([ReportKind.Weekly, ReportKind.Monthly]);
  });

  it("a kind whose closed period already has a report is not due", () => {
    const existing = [
      { kind: ReportKind.Weekly, periodStartIso: iso(ReportKind.Weekly) },
      { kind: ReportKind.Monthly, periodStartIso: iso(ReportKind.Monthly) },
    ];
    expect(dueKinds(DEFAULT_REPORT_PREFERENCES, existing, NOW)).toEqual([]);
  });

  it("an older period for the same kind still leaves the current period due", () => {
    const existing = [{ kind: ReportKind.Weekly, periodStartIso: "2026-07-20" }];
    expect(dueKinds(DEFAULT_REPORT_PREFERENCES, existing, NOW)).toEqual([ReportKind.Weekly, ReportKind.Monthly]);
  });

  it("disabled kinds never appear", () => {
    const prefs = parseReportPreferences({ kinds: { WEEKLY: false, MONTHLY: false } });
    expect(dueKinds(prefs, [], NOW)).toEqual([]);
  });
});
