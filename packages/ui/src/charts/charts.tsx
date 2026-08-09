import { useId, useMemo, useState, type ReactNode } from "react";
import { cn } from "../cn";
import { areaPath, niceTicks, seriesExtent, smoothPath, toPoints } from "./chart-utils";

/**
 * SVG charts (P9): area trend, sparkline, stacked mini-bars, gauge. No chart
 * library — exact token colors, tiny bundle, deterministic math (see
 * chart-utils.ts tests). All charts are labelled regions; series legends are
 * real text, not tooltip-only.
 */

const CHART_VARS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
] as const;

/* ─── AreaChart ──────────────────────────────────────────────────────────── */

export interface AreaChartProps {
  /** Multiple series supported; single-series renders with a soft fill. */
  readonly series: ReadonlyArray<{ label: string; values: readonly number[] }>;
  readonly xLabels?: readonly string[];
  readonly height?: number;
  readonly formatY?: (value: number) => string;
  readonly className?: string;
  readonly testId?: string;
}

export function AreaChart({
  series,
  xLabels,
  height = 220,
  formatY = (v) => String(Math.round(v)),
  className,
  testId,
}: AreaChartProps): ReactNode {
  const gradientId = useId();
  const width = 640;
  const paddedHeight = height;
  const plotBottom = paddedHeight - 18;
  const plotTop = 8;

  const { flat, ticks } = useMemo(() => {
    const all = series.flatMap((s) => [...s.values]);
    const { min, max } = seriesExtent(all);
    return { flat: all, ticks: niceTicks(min === max ? 0 : min, max, 4) };
  }, [series]);

  const labelEvery = xLabels !== undefined ? Math.max(1, Math.ceil(xLabels.length / 6)) : 1;

  return (
    <figure
      className={cn("w-full", className)}
      role="img"
      aria-label={`Trend chart: ${series.map((s) => s.label).join(", ")}`}
      data-testid={testId}
    >
      <svg viewBox={`0 0 ${String(width)} ${String(paddedHeight)}`} className="w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`${gradientId}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_VARS[0]} stopOpacity="0.35" />
            <stop offset="100%" stopColor={CHART_VARS[0]} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => {
          const { min, max } = seriesExtent(flat);
          const span = max - min;
          const y = plotTop + (span === 0 ? (plotBottom - plotTop) / 2 : (1 - (tick - min) / span) * (plotBottom - plotTop));
          return (
            <g key={String(tick)}>
              <line x1={40} y1={y} x2={width - 4} y2={y} stroke="var(--color-subtle)" strokeDasharray="3 5" strokeWidth="0.6" />
              <text x={34} y={y + 3} textAnchor="end" fontSize="9" fill="var(--color-faint)">
                {formatY(tick)}
              </text>
            </g>
          );
        })}
        {series.map((serie, si) => {
          const points = toPoints(serie.values, width - 44, plotBottom - plotTop, 0).map((p) => ({
            x: p.x + 40,
            y: p.y + plotTop,
          }));
          const color = CHART_VARS[si % CHART_VARS.length]!;
          return (
            <g key={serie.label}>
              {si === 0 && (
                <path d={areaPath(points, width, plotBottom)} fill={`url(#${gradientId}-fill)`} stroke="none" />
              )}
              <path
                d={smoothPath(points)}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        {xLabels?.map((label, index) =>
          index % labelEvery === 0 ? (
            <text
              key={`${label}-${String(index)}`}
              x={40 + (series[0] !== undefined && series[0].values.length > 1
                ? (index / (series[0].values.length - 1)) * (width - 44)
                : 0)}
              y={paddedHeight - 4}
              textAnchor="middle"
              fontSize="9"
              fill="var(--color-faint)"
            >
              {label}
            </text>
          ) : null,
        )}
      </svg>
      {series.length > 1 && (
        <figcaption className="mt-1 flex flex-wrap items-center gap-4 px-1">
          {series.map((serie, si) => (
            <span key={serie.label} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: CHART_VARS[si % CHART_VARS.length] }}
                aria-hidden
              />
              {serie.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

/* ─── Sparkline ──────────────────────────────────────────────────────────── */

export function Sparkline({
  values,
  height = 36,
  color = CHART_VARS[0],
  className,
}: {
  values: readonly number[];
  height?: number;
  color?: string;
  className?: string;
}): ReactNode {
  const id = useId();
  const width = 128;
  const points = useMemo(() => toPoints(values, width, height, 2), [values, height]);
  if (points.length === 0) return null;
  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className={cn("h-9 w-32", className)}
      role="img"
      aria-label="Sparkline trend"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`${id}-spark`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath(points, width, height)} fill={`url(#${id}-spark)`} stroke="none" />
      <path d={smoothPath(points)} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <circle cx={points[points.length - 1]!.x} cy={points[points.length - 1]!.y} r="2.2" fill={color} />
    </svg>
  );
}

/* ─── Gauge (scores, health) ─────────────────────────────────────────────── */

export function Gauge({
  value,
  max = 100,
  label,
  tone = "primary",
  size = 116,
  className,
}: {
  value: number;
  max?: number;
  label?: string;
  tone?: "primary" | "success" | "warning" | "danger";
  size?: number;
  className?: string;
}): ReactNode {
  const ratio = max === 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = ratio * circumference;
  const colors = {
    primary: "var(--color-primary)",
    success: "var(--color-success)",
    warning: "var(--color-warning)",
    danger: "var(--color-danger)",
  } as const;
  return (
    <div className={cn("relative inline-grid place-items-center", className)} role="img" aria-label={`Score: ${String(Math.round(value))} of ${String(max)}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-surface-raised)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colors[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${String(dash)} ${String(circumference)}`}
          style={{ transition: "stroke-dasharray 600ms cubic-bezier(0.4,0,0.2,1)" }}
        />
      </svg>
      <div className="absolute text-center">
        <p className="text-2xl font-semibold tabular-nums text-foreground">{Math.round(value)}</p>
        {label !== undefined && <p className="text-[10px] uppercase tracking-wider text-faint">{label}</p>}
      </div>
    </div>
  );
}

/* ─── HealthBar (sync freshness / status strips) ─────────────────────────── */

export function HealthBar({
  segments,
  className,
}: {
  segments: ReadonlyArray<{ label: string; tone: "success" | "warning" | "danger" | "muted"; count: number }>;
  className?: string;
}): ReactNode {
  const total = segments.reduce((acc, s) => acc + s.count, 0);
  const toneClass = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    muted: "bg-faint/40",
  } as const;
  return (
    <div className={className}>
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Status distribution">
        {segments
          .filter((s) => s.count > 0)
          .map((segment) => (
            <div
              key={segment.label}
              className={cn("h-full", toneClass[segment.tone])}
              style={{ width: total === 0 ? "0%" : `${String((segment.count / total) * 100)}%` }}
            />
          ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {segments.map((segment) => (
          <span key={segment.label} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
            <span className={cn("inline-block size-1.5 rounded-full", toneClass[segment.tone])} aria-hidden />
            {segment.label} · {segment.count}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─── Interactive hover state (shared) ───────────────────────────────────── */

export function useChartHover(): { hovered: number | null; setHovered: (index: number | null) => void } {
  const [hovered, setHovered] = useState<number | null>(null);
  return { hovered, setHovered };
}
