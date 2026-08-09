/**
 * Shared display formatting (P9 typography rules for numbers/dates). Money
 * and chart labels come from @profit/ui chart-utils — this module holds the
 * remaining app-level concerns: exact timestamps and relative recency, both
 * rendered against the merchant's real clock.
 */

/** "Aug 5, 2026" — date-only cells (admin tables, billing ledger dates). */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/** "Aug 5, 2026, 14:32" — table cells, audit rows, sync timestamps. */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** "just now" · "3m ago" · "2h ago" · "4d ago" · then falls back to the date. */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso === null || iso === undefined || iso === "") return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${String(days)}d ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

/** Decimal string ("1299.00") from numeric DB columns → formatted money. */
export function formatDecimalMoney(
  decimal: string | null | undefined,
  currency: string,
): string {
  if (decimal === null || decimal === undefined || decimal === "") return "—";
  const value = Number(decimal);
  if (Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

/** Trial countdown shown on Billing/Onboarding — whole days, floored at 0. */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (iso === null || iso === undefined || iso === "") return null;
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) return null;
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (24 * 3600 * 1000)));
}
