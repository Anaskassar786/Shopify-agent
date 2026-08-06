import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, RefreshCw, SearchX } from "lucide-react";
import { cn } from "../cn";
import { Button } from "./primitives";

/* ─── Spinner ────────────────────────────────────────────────────────────── */

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }): ReactNode {
  return <Loader2 className={cn("size-5 animate-spin text-muted", className)} aria-label={label} role="status" />;
}

/* ─── Skeleton ───────────────────────────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }): ReactNode {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-surface-raised", className)} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }): ReactNode {
  return (
    <div aria-hidden className={cn("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/* ─── ProgressBar ────────────────────────────────────────────────────────── */

export function ProgressBar({
  value,
  tone = "primary",
  className,
  label,
}: {
  value: number;
  tone?: "primary" | "success" | "warning" | "danger";
  className?: string;
  label?: string;
}): ReactNode {
  const clamped = Math.min(100, Math.max(0, value));
  const toneClass = {
    primary: "bg-primary",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
  }[tone];
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-raised", className)}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={cn("h-full rounded-full transition-all duration-500", toneClass)}
        style={{ width: `${String(clamped)}%` }}
      />
    </div>
  );
}

/* ─── AnimatedNumber ─────────────────────────────────────────────────────── */

/** Count-up on value change (P9: animated counters; respects reduced motion). */
export function AnimatedNumber({
  value,
  durationMs = 600,
  format = (n: number) => n.toLocaleString("en-US"),
  className,
}: {
  value: number;
  durationMs?: number;
  format?: (n: number) => string;
  className?: string;
}): ReactNode {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    const to = value;
    previous.current = value;
    if (from === to) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(to);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (to - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return <span className={cn("tabular-nums", className)}>{format(Math.round(display))}</span>;
}

/* ─── EmptyState / ErrorState (P9 patterns) ──────────────────────────────── */

export function EmptyState({
  icon,
  title,
  body,
  primaryAction,
  secondaryAction,
  className,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      <div className="flex size-12 items-center justify-center rounded-lg bg-surface-raised text-faint">
        {icon ?? <SearchX className="size-6" aria-hidden />}
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {body !== undefined && <p className="max-w-sm text-[13px] leading-relaxed text-muted">{body}</p>}
      {(primaryAction !== undefined || secondaryAction !== undefined) && (
        <div className="mt-2 flex items-center gap-3">
          {primaryAction}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  body,
  errorId,
  onRetry,
  className,
}: {
  title?: string | undefined;
  body?: string | undefined;
  errorId?: string | undefined;
  onRetry?: (() => void) | undefined;
  className?: string | undefined;
}): ReactNode {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)} role="alert">
      <div className="flex size-12 items-center justify-center rounded-lg bg-danger-soft text-danger">
        <AlertTriangle className="size-6" aria-hidden />
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="max-w-sm text-[13px] leading-relaxed text-muted">
        {body ?? "The request could not be completed. You can retry — if it keeps failing, share the error ID with support."}
      </p>
      {errorId !== undefined && (
        <code className="rounded-md bg-surface-raised px-2.5 py-1 font-mono text-[11px] text-faint">
          error id: {errorId}
        </code>
      )}
      {onRetry !== undefined && (
        <Button variant="secondary" size="sm" iconLeft={<RefreshCw className="size-3.5" aria-hidden />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
