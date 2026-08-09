import { useState, type ReactNode } from "react";
import type { BadgeTone } from "@profit/ui";
import { ProgressBar } from "@profit/ui";
import { ApiError } from "../lib/api-client";
import { isEntitlementError } from "../lib/entitlement";
import { UpgradeNotice } from "../components/UpgradeNotice";

/**
 * Shared AI-plane display contracts (M4): status/priority tones, confidence
 * rendering, and type labels. One home so the list, detail, command center
 * and automation ledger never drift on the same vocabulary the API emits.
 */

export const PRIORITY_TONE: Readonly<Record<string, BadgeTone>> = {
  CRITICAL: "danger",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
};

export const RECOMMENDATION_STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  PENDING_APPROVAL: "warning",
  APPROVED: "info",
  SCHEDULED: "info",
  EXECUTING: "primary",
  EXECUTED: "success",
  MEASURED: "success",
  REJECTED: "neutral",
  EXPIRED: "neutral",
  FAILED: "danger",
};

export const EXECUTION_STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  PENDING: "neutral",
  RUNNING: "primary",
  SUCCEEDED: "success",
  FAILED: "danger",
};

export const RECOMMENDATION_EVENT_LABEL: Readonly<Record<string, string>> = {
  CREATED: "Created",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  AUTO_APPROVED: "Auto-approved",
  EXECUTION_QUEUED: "Execution queued",
  EXECUTED: "Executed",
  EXECUTION_FAILED: "Execution failed",
  EXPIRED: "Expired",
  MEASURED: "Measured",
};

/** Machine types → plain English (P9 copy rules: sentence case, no codes). */
export function recommendationTypeLabel(type: string): string {
  const label = type.replaceAll("_", " ").toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function priorityLabel(priority: string): string {
  return priority.charAt(0) + priority.slice(1).toLowerCase();
}

export function statusLabel(status: string): string {
  return recommendationTypeLabel(status);
}

/** USD micros (engine cost accounting) → honest sub-cent display. */
export function formatCostMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars === 0) return "$0.00";
  if (dollars < 0.01) return `<$0.01`;
  return `$${dollars.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

/** Provider confidence 0–100 as a meter + tier word (P10 tiers). */
export function ConfidenceMeter({ value, tier }: { readonly value: number; readonly tier?: string | undefined }): ReactNode {
  const tone = value >= 90 ? "success" : value >= 70 ? "primary" : "warning";
  return (
    <div className="flex min-w-28 flex-col gap-1" aria-label={`Confidence ${String(value)} out of 100`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="tabular-nums text-xs font-semibold text-foreground">{value}</span>
        <span className="text-[10px] uppercase tracking-wide text-faint">
          {tier ?? (value >= 90 ? "high" : value >= 70 ? "review" : "low")}
        </span>
      </div>
      <ProgressBar value={value} tone={tone} />
    </div>
  );
}

/* ─── Entitlement-denial UX (M5) ─────────────────────────────────────────── */

/**
 * Shared hook for AI-plane pages: turns UPGRADE_REQUIRED / QUOTA_EXCEEDED
 * mutation refusals into an inline upgrade CTA (a denial is a billing
 * conversation, not a crash); every other error falls through to the caller's
 * ordinary toast copy. One page-level instance renders `notice` anywhere.
 */
export function useEntitlementNotice(): {
  readonly notice: ReactNode;
  readonly handleMutationError: (fallback: (error: ApiError) => void) => (error: ApiError) => void;
} {
  const [message, setMessage] = useState<string | null>(null);
  return {
    notice:
      message === null ? null : (
        <UpgradeNotice message={message} onDismiss={() => setMessage(null)} />
      ),
    handleMutationError:
      (fallback) =>
      (error) => {
        if (isEntitlementError(error)) {
          setMessage(error.message);
          return;
        }
        fallback(error);
      },
  };
}
