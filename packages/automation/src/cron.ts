/**
 * Deterministic 5-field cron (M6 workflow scheduler). UTC only — merchant
 * timezone conversion is a UI concern; the engine stores next_fire_at in UTC.
 *
 * Supported syntax per field: star, star+step (every n), single values,
 * comma lists, ranges, and range+step combos.
 * Day-of-week accepts 0-7 (0 and 7 = Sunday). When BOTH day-of-month and
 * day-of-week are restricted, POSIX OR-semantics apply (match if either).
 *
 * No external dependency: the grammar is small, the behavior must be pinned
 * by our own property tests either way, and a parser bug here fires merchant
 * messages at the wrong time — ownership beats convenience.
 */

export interface CronField {
  /** True for `*` — every value in range matches. */
  readonly any: boolean;
  /** Matching values, ascending, deduped. */
  readonly values: readonly number[];
}

export interface CronSchedule {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
  /** Normalized expression (for logging/diagnostics). */
  readonly source: string;
}

interface FieldSpec {
  readonly min: number;
  readonly max: number;
  /** Optional value normalization (dow: 7 → 0). */
  readonly normalize?: (value: number) => number;
}

const MINUTE: FieldSpec = { min: 0, max: 59 };
const HOUR: FieldSpec = { min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { min: 1, max: 31 };
const MONTH: FieldSpec = { min: 1, max: 12 };
const DAY_OF_WEEK: FieldSpec = { min: 0, max: 7, normalize: (v: number): number => (v === 7 ? 0 : v) };

const FIELD_PATTERN = /^[\d*,/-]+$/;

function parseField(raw: string, spec: FieldSpec): CronField | null {
  if (raw === "*") return { any: true, values: [] };
  if (!FIELD_PATTERN.test(raw)) return null;
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (part === "") return null;
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length > 0 || rangePart === undefined) return null;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number.parseInt(stepPart, 10);
      if (step < 1) return null;
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes("-")) {
      const [loRaw, hiRaw, ...rangeRest] = rangePart.split("-");
      if (rangeRest.length > 0 || loRaw === undefined || hiRaw === undefined) return null;
      if (!/^\d+$/.test(loRaw) || !/^\d+$/.test(hiRaw)) return null;
      hi = Number.parseInt(hiRaw, 10);
      lo = Number.parseInt(loRaw ?? "0", 10);
      if (lo > hi) return null;
    } else {
      if (!/^\d+$/.test(rangePart)) return null;
      lo = Number.parseInt(rangePart, 10);
      hi = rangePart.includes("/") ? spec.max : lo;
    }
    if (lo < spec.min || hi > spec.max) return null;
    for (let v = lo; v <= hi; v += step) {
      values.add(spec.normalize !== undefined ? spec.normalize(v) : v);
    }
  }
  return { any: false, values: [...values].sort((a, b) => a - b) };
}

/** Parse a 5-field cron expression; null when the expression is invalid. */
export function parseCron(expression: string): CronSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const fields: [CronField | null, CronField | null, CronField | null, CronField | null, CronField | null] = [
    parseField(minute, MINUTE),
    parseField(hour, HOUR),
    parseField(dom, DAY_OF_MONTH),
    parseField(month, MONTH),
    parseField(dow, DAY_OF_WEEK),
  ];
  for (const field of fields) if (field === null) return null;
  const [minuteF, hourF, domF, monthF, dowF] = fields as [CronField, CronField, CronField, CronField, CronField];
  return {
    minute: minuteF,
    hour: hourF,
    dayOfMonth: domF,
    month: monthF,
    dayOfWeek: dowF,
    source: expression.trim(),
  };
}

function matches(field: CronField, value: number): boolean {
  return field.any || field.values.includes(value);
}

function daysInMonthUtc(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

const DAY_MS = 86_400_000;
/** How far ahead nextOccurrence may scan (leap-inclusive). */
export const CRON_SCAN_HORIZON_DAYS = 366 * 4 + 1;

/**
 * Next fire strictly AFTER `from` (minute precision), or null when the
 * schedule never fires within the horizon. Deterministic: same inputs, same
 * instant; `from` seconds/milliseconds are truncated, never rounded up into
 * the current minute.
 */
export function nextOccurrence(schedule: CronSchedule, from: Date): Date | null {
  const cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);

  for (let day = 0; day < CRON_SCAN_HORIZON_DAYS; day += 1) {
    const year = cursor.getUTCFullYear();
    const monthIndex = cursor.getUTCMonth();
    const monthNumber = monthIndex + 1;
    if (!matches(schedule.month, monthNumber)) {
      // Jump to the first day of next month.
      cursor.setTime(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
      continue;
    }
    const dayOfMonth = cursor.getUTCDate();
    if (dayOfMonth > daysInMonthUtc(year, monthIndex)) {
      cursor.setTime(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
      continue;
    }
    const domMatch = schedule.dayOfMonth.any || schedule.dayOfMonth.values.includes(dayOfMonth);
    const dowMatch = schedule.dayOfWeek.any || schedule.dayOfWeek.values.includes(cursor.getUTCDay());
    // POSIX: both restricted ⇒ OR; otherwise AND with `any` tautologies.
    const bothRestricted = !schedule.dayOfMonth.any && !schedule.dayOfWeek.any;
    const dayMatches = bothRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatches) {
      cursor.setTime(cursor.getTime() + DAY_MS);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    for (const hour of schedule.hour.any ? rangeHours(cursor) : schedule.hour.values) {
      if (hour < cursor.getUTCHours()) continue;
      for (const minute of schedule.minute.any ? rangeMinutes(cursor, hour) : schedule.minute.values) {
        if (hour === cursor.getUTCHours() && minute < cursor.getUTCMinutes()) continue;
        const candidate = new Date(Date.UTC(year, monthIndex, dayOfMonth, hour, minute, 0, 0));
        if (candidate.getTime() > from.getTime()) return candidate;
      }
    }
    cursor.setTime(cursor.getTime() + DAY_MS);
    cursor.setUTCHours(0, 0, 0, 0);
  }
  return null;
}

function* rangeHours(cursor: Date): Generator<number> {
  for (let h = cursor.getUTCHours(); h <= 23; h += 1) yield h;
}

function* rangeMinutes(cursor: Date, hour: number): Generator<number> {
  const start = hour === cursor.getUTCHours() ? cursor.getUTCMinutes() : 0;
  for (let m = start; m <= 59; m += 1) yield m;
}
