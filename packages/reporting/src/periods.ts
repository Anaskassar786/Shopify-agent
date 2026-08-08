import { ReportKind, type ReportKind as ReportKindValue } from "@profit/types";

/**
 * Period math (M8, ADR 34): a report always covers one FULLY CLOSED UTC
 * period — yesterday, last ISO week, last calendar month, last quarter. No
 * partial windows, so a daily report dated today never mutates under its own
 * idempotency key (store, kind, periodStart, periodEnd).
 */

export interface ReportPeriod {
  /** Inclusive UTC start. */
  readonly start: Date;
  /** EXCLUSIVE UTC end. */
  readonly end: Date;
}

const DAY_MS = 86_400_000;
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Monday 00:00Z of the ISO week containing `date`. */
function isoWeekStart(date: Date): Date {
  const midnight = utcMidnight(date);
  const day = (midnight.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(midnight.getTime() - day * DAY_MS);
}

function monthStart(date: Date, offsetMonths = 0): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offsetMonths, 1));
}

function quarterStart(date: Date, offsetQuarters = 0): Date {
  const quarterFirstMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), quarterFirstMonth + offsetQuarters * 3, 1));
}

/** The fully-closed period this kind should report on for `now`. */
export function closedPeriodFor(kind: ReportKindValue, now: Date): ReportPeriod {
  switch (kind) {
    case ReportKind.Daily: {
      const end = utcMidnight(now);
      return { start: new Date(end.getTime() - DAY_MS), end };
    }
    case ReportKind.Weekly: {
      const end = isoWeekStart(now);
      return { start: new Date(end.getTime() - 7 * DAY_MS), end };
    }
    case ReportKind.Monthly: {
      return { start: monthStart(now, -1), end: monthStart(now) };
    }
    case ReportKind.Quarterly: {
      return { start: quarterStart(now, -1), end: quarterStart(now) };
    }
  }
}

/** The equal-length window immediately before the period (delta baseline). */
export function priorPeriodFor(period: ReportPeriod): ReportPeriod {
  const length = period.end.getTime() - period.start.getTime();
  return { start: new Date(period.start.getTime() - length), end: period.start };
}

export function periodLengthDays(period: ReportPeriod): number {
  return Math.round((period.end.getTime() - period.start.getTime()) / DAY_MS);
}

function fmtDay(date: Date): string {
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export function periodLabel(kind: ReportKindValue, period: ReportPeriod): string {
  const inclusiveEnd = new Date(period.end.getTime() - DAY_MS);
  switch (kind) {
    case ReportKind.Daily:
      return fmtDay(period.start);
    case ReportKind.Weekly:
      return `${fmtDay(period.start)} – ${fmtDay(inclusiveEnd)}`;
    case ReportKind.Monthly:
      return `${MONTHS_SHORT[period.start.getUTCMonth()]} ${period.start.getUTCFullYear()}`;
    case ReportKind.Quarterly: {
      const quarter = Math.floor(period.start.getUTCMonth() / 3) + 1;
      return `Q${quarter} ${period.start.getUTCFullYear()} (${fmtDay(period.start)} – ${fmtDay(inclusiveEnd)})`;
    }
  }
}

/** ISO date keys for metric-date columns (period comparisons are string-safe). */
export function periodIsoRange(period: ReportPeriod): { from: string; toExclusive: string } {
  return {
    from: period.start.toISOString().slice(0, 10),
    toExclusive: period.end.toISOString().slice(0, 10),
  };
}
