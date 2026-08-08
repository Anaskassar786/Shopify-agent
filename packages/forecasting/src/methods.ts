/**
 * Deterministic forecast math (M8, ADR 33). Every method is pure, documented,
 * and method-versioned — the DTO layer stamps `ForecastMethod.*` next to every
 * result so a method bump is auditable and a stale cached report is detectable.
 *
 * Numbers are integer cents / whole units; float happens only on ratios inside
 * a computation, never in what we store.
 */

export interface DailyPoint {
  /** UTC date YYYY-MM-DD. */
  readonly date: string;
  readonly valueCents: number;
}

export interface DailyForecastPoint {
  readonly date: string;
  readonly expectedCents: number;
  readonly lowCents: number;
  readonly highCents: number;
}

export interface RevenueForecastResult {
  readonly horizonDays: number;
  readonly points: readonly DailyForecastPoint[];
  readonly totalExpectedCents: number;
  readonly totalLowCents: number;
  readonly totalHighCents: number;
  /** Least-squares slope over the trailing window (cents/day, rounded). */
  readonly trendCentsPerDay: number;
  /** Coefficient of determination of the fitted window (0–1, 2dp). */
  readonly fitR2: number;
  /** Trailing-window days actually used (≥ MIN_WINDOW_DAYS required). */
  readonly windowDays: number;
}

export const REVENUE_WINDOW_DAYS = 56;
export const MIN_WINDOW_DAYS = 14;
/** 80% interval multiplier (normal approximation). */
const BAND_Z = 1.28;

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Least-squares line over a series indexed 0..n-1. */
function linearFit(values: readonly number[]): { slope: number; intercept: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: mean(values), r2: 0 };
  const xs = values.map((_, i) => i);
  const meanX = mean(xs);
  const meanY = mean(values);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += ((xs[i] ?? 0) - meanX) * ((values[i] ?? 0) - meanY);
    sxx += ((xs[i] ?? 0) - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const total = values.reduce((sum, y) => sum + (y - meanY) ** 2, 0);
  let explained = 0;
  for (let i = 0; i < n; i += 1) {
    explained += (intercept + slope * (xs[i] ?? 0) - meanY) ** 2;
  }
  const r2 = total === 0 ? 1 : Math.max(0, Math.min(1, explained / total));
  return { slope, intercept, r2 };
}

function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekday(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00.000Z`).getUTCDay();
}

/**
 * revenue.weekly-seasonality.v1
 *   expected(day) = weekdaySeasonalMean + trendSlope × daysAhead
 *   band         = residualStddev × 1.28 × √(1 + daysAhead/7)  (widening with
 *                  distance is the honest part of the interval)
 * The residual stddev is measured on (actual − fit) over the trailing window,
 * so a noisy store gets wide bands, a steady store narrow ones — confidence
 * is derived from fit + window sufficiency, never invented.
 */
export function forecastRevenue(
  daily: readonly DailyPoint[],
  horizonDays: number,
  todayIso: string,
): RevenueForecastResult | null {
  const window = daily
    .filter((point) => point.date < todayIso)
    .slice(-REVENUE_WINDOW_DAYS);
  if (window.length < MIN_WINDOW_DAYS || horizonDays < 1) return null;

  const values = window.map((point) => point.valueCents);
  const { slope, r2 } = linearFit(values);
  const seasonal = new Map<number, { sum: number; count: number }>();
  window.forEach((point, index) => {
    const wd = weekday(point.date);
    const residual = point.valueCents - (mean(values) + slope * (index - (window.length - 1) / 2));
    const entry = seasonal.get(wd) ?? { sum: 0, count: 0 };
    entry.sum += residual;
    entry.count += 1;
    seasonal.set(wd, entry);
  });
  const seasonalOffset = (wd: number): number => {
    const entry = seasonal.get(wd);
    return entry === undefined || entry.count === 0 ? 0 : entry.sum / entry.count;
  };

  const fitted = window.map((point, index) => {
    const trendComponent = mean(values) + slope * (index - (window.length - 1) / 2);
    return point.valueCents - (trendComponent + seasonalOffset(weekday(point.date)));
  });
  const residualStd = Math.sqrt(mean(fitted.map((residual) => residual ** 2)));

  const center = mean(values) + slope * (window.length / 2);
  const points: DailyForecastPoint[] = [];
  for (let day = 1; day <= horizonDays; day += 1) {
    const dateIso = addDays(todayIso, day);
    const expected = Math.max(
      0,
      Math.round(center + seasonalOffset(weekday(dateIso)) + slope * day),
    );
    const half = Math.round(residualStd * BAND_Z * Math.sqrt(1 + day / 7));
    points.push({
      date: dateIso,
      expectedCents: expected,
      lowCents: Math.max(0, expected - half),
      highCents: expected + half,
    });
  }
  return {
    horizonDays,
    points,
    totalExpectedCents: points.reduce((sum, point) => sum + point.expectedCents, 0),
    totalLowCents: points.reduce((sum, point) => sum + point.lowCents, 0),
    totalHighCents: points.reduce((sum, point) => sum + point.highCents, 0),
    trendCentsPerDay: Math.round(slope),
    fitR2: Math.round(r2 * 100) / 100,
    windowDays: window.length,
  };
}

export const DEMAND_RECENT_DAYS = 14;
export const DEMAND_TRAILING_DAYS = 30;
const DEMAND_RECENT_WEIGHT = 0.6;
const DEMAND_TRAILING_WEIGHT = 0.4;

/**
 * demand.velocity.v1 — blended velocity (60% recent 14d, 40% trailing 30d),
 * demand = velocity × horizon. Velocity ≤ 0 ⇒ 0 forecast (not negative stock).
 */
export function forecastDemand(
  unitsLast14d: number,
  unitsLast30d: number,
  horizonDays: number,
): { readonly velocityPerDay: number; readonly expectedUnits: number } {
  const recent = unitsLast14d / DEMAND_RECENT_DAYS;
  const trailing = unitsLast30d / DEMAND_TRAILING_DAYS;
  const velocity = Math.max(0, recent * DEMAND_RECENT_WEIGHT + trailing * DEMAND_TRAILING_WEIGHT);
  return { velocityPerDay: velocity, expectedUnits: Math.round(velocity * horizonDays * 10) / 10 };
}

/**
 * stockout.velocity.v1 — days of cover = onHand ÷ velocity. Never in stock ⇒
 * already 0. Never selling ⇒ null (no date computable, honest).
 */
export function daysOfCover(onHand: number, velocityPerDay: number): number | null {
  if (onHand <= 0) return 0;
  if (velocityPerDay <= 0) return null;
  return Math.round((onHand / velocityPerDay) * 10) / 10;
}

/**
 * churn.rfm.v1 — per-customer risk score 0–100 from the lifetime snapshot:
 *   expectedInterval = daysBetween(first,last) / max(orders-1,1) (floor 7d)
 *   lateness         = daysSinceLastOrder − expectedInterval
 *   score            = clamp(100 × lateness / (4 × expectedInterval))
 * A customer inside their cadence scores 0; 4× late ⇒ churned (100).
 */
export function churnRiskScore(
  firstOrderAt: Date,
  lastOrderAt: Date,
  ordersCount: number,
  nowMs: number,
): number {
  const MIN_INTERVAL_DAYS = 7;
  const spanDays = Math.max(0, (lastOrderAt.getTime() - firstOrderAt.getTime()) / 86_400_000);
  const expectedInterval = Math.max(MIN_INTERVAL_DAYS, spanDays / Math.max(ordersCount - 1, 1));
  const daysSince = Math.max(0, (nowMs - lastOrderAt.getTime()) / 86_400_000);
  const lateness = Math.max(0, daysSince - expectedInterval);
  return Math.min(100, Math.round((100 * lateness) / (4 * expectedInterval)));
}
