/**
 * USD micros (engine cost accounting: 1/1_000_000 dollar) → merchant-facing
 * dollars. Shared by the admin console's AI-usage views and owned by no one
 * feature — the ai-page variant (sub-cent precision) stays put in ai-shared.
 */
export function formatCostMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  if (!Number.isFinite(dollars) || dollars <= 0) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}
