/**
 * Period-over-period deltas for hero stat cards: split the visible range in
 * half and compare real sums. Returns null when the baseline is zero — a
 * "∞%" badge would be noise, so cards render a neutral hint instead.
 */
export interface SeriesDelta {
  readonly pct: number;
  readonly direction: "up" | "down";
}

export function halfSplitDelta(values: readonly number[]): SeriesDelta | null {
  if (values.length < 2) return null;
  const mid = Math.floor(values.length / 2);
  const first = values.slice(0, mid).reduce((acc, v) => acc + v, 0);
  const second = values.slice(mid).reduce((acc, v) => acc + v, 0);
  if (first === 0) return null;
  const pct = ((second - first) / first) * 100;
  if (!Number.isFinite(pct) || pct === 0) return null;
  return { pct, direction: pct > 0 ? "up" : "down" };
}

export function formatDelta(delta: SeriesDelta | null): string | null {
  if (delta === null) return null;
  const sign = delta.pct > 0 ? "+" : "";
  return `${sign}${delta.pct.toFixed(1)}%`;
}
