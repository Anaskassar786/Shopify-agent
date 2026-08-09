/**
 * Chart math — pure functions, deterministic, unit-tested. SVG charts stay
 * dependency-free (P9: performance-friendly micro-animations, exact brand
 * colors from tokens rather than a chart library's defaults).
 */

export interface DataPoint {
  readonly x: number;
  readonly y: number;
}

export interface Series {
  readonly label: string;
  readonly values: readonly number[];
}

/** Evenly spread y-axis ticks, nice-rounded to 1/2/5 steps. */
export function niceTicks(min: number, max: number, count = 4): readonly number[] {
  if (count < 2) return [min];
  const lo = Math.min(min, 0);
  const hi = max <= lo ? lo + 1 : max;
  const rawStep = (hi - lo) / (count - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  const step = residual >= 5 ? 5 * magnitude : residual >= 2 ? 2 * magnitude : magnitude;
  const start = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= hi + step / 2 && ticks.length < count + 2; value += step) {
    ticks.push(Math.round(value * 1e6) / 1e6);
  }
  return ticks;
}

export function seriesExtent(values: readonly number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 1 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Map values to viewBox coordinates (top-left origin). */
export function toPoints(
  values: readonly number[],
  width: number,
  height: number,
  padding = 2,
): readonly DataPoint[] {
  if (values.length === 0) return [];
  const { min, max } = seriesExtent(values);
  const span = max - min;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  return values.map((value, index) => ({
    x: padding + (values.length === 1 ? innerW / 2 : (index / (values.length - 1)) * innerW),
    y: padding + innerH - (span === 0 ? innerH / 2 : ((value - min) / span) * innerH),
  }));
}

/** Smooth path through points (Catmull-Rom → cubic Bézier). */
export function smoothPath(points: readonly DataPoint[]): string {
  if (points.length === 0) return "";
  if (points.length < 3) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${String(p.x)},${String(p.y)}`).join(" ");
  }
  const parts: string[] = [`M${String(points[0]!.x)},${String(points[0]!.y)}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    parts.push(
      `C${String(cp1x)},${String(cp1y)} ${String(cp2x)},${String(cp2y)} ${String(p2.x)},${String(p2.y)}`,
    );
  }
  return parts.join(" ");
}

/** Smooth path closed against the baseline for area fills. */
export function areaPath(points: readonly DataPoint[], width: number, height: number): string {
  if (points.length === 0) return "";
  const line = smoothPath(points);
  const last = points[points.length - 1]!;
  const first = points[0]!;
  return `${line} L${String(last.x)},${String(height)} L${String(first.x)},${String(height)} Z`;
}

/** Compact money/currency formatter: 1234567 → "$1.2M". */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}K`;
  return String(Math.round(value * 100) / 100);
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Cents → localized currency string (integer cents contract from metrics). */
export function formatMoney(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatDateLabel(isoDate: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", options ?? { month: "short", day: "numeric" }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );
}
