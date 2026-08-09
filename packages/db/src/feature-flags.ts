import { eq } from "drizzle-orm";
import { FeatureFlag } from "@profit/types";
import type { ProfitDb } from "./client";
import { storeSettings } from "./schema/merchant";

/**
 * Per-merchant feature flags (launch readiness, ADR 37): typed reader over the
 * EXISTING `store_settings.featureOverrides` jsonb — no new column, the schema
 * shipped the container at M1. Flags are platform-managed (admin API writes
 * them with an operator audit trail); merchants never toggle them directly.
 *
 * Semantics (documented in the milestone/launch docs):
 *  - a flag DISABLES a capability: provider-crossing AI writes, workflow
 *    mutations + new run starts;
 *  - reads are never gated — a disabled feature hides no merchant data;
 *  - unknown keys in the jsonb are ignored (forward-compatible rollouts).
 *
 * Read path is OWNER-scoped by design: enforcement points (API guards, worker
 * run-start) already hold a verified storeId and consult their OWN tenant's
 * row — cross-tenant exposure is impossible by argument order, not by RLS here.
 */
export type FeatureFlagsMap = Partial<Record<FeatureFlag, boolean>>;

/** Parses the raw jsonb into the closed taxonomy — unknown/malformed keys drop. */
export function parseFeatureOverrides(raw: unknown): FeatureFlagsMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const flags: FeatureFlagsMap = {};
  for (const key of Object.values(FeatureFlag)) {
    const value = source[key];
    if (typeof value === "boolean") flags[key] = value;
  }
  return flags;
}

export async function featureFlagsFor(db: ProfitDb, storeId: string): Promise<FeatureFlagsMap> {
  const rows = await db
    .select({ featureOverrides: storeSettings.featureOverrides })
    .from(storeSettings)
    .where(eq(storeSettings.storeId, storeId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return {};
  return parseFeatureOverrides(row.featureOverrides);
}

/**
 * Patch input tolerates explicit `undefined` values (the exact zod
 * `.optional()` output shape under exactOptionalPropertyTypes) — undefined
 * keys are ignored by the merge, never persisted.
 */
export type FeatureFlagsPatch = { readonly [K in FeatureFlag]?: boolean | undefined };

/** Merge-write: only taxonomy keys persist; the merge is last-write-wins per key. */
export async function mergeFeatureOverrides(
  db: ProfitDb,
  storeId: string,
  patch: FeatureFlagsPatch,
): Promise<FeatureFlagsMap> {
  const rows = await db
    .select({ id: storeSettings.id, featureOverrides: storeSettings.featureOverrides })
    .from(storeSettings)
    .where(eq(storeSettings.storeId, storeId))
    .limit(1);
  const current = rows[0];
  if (current === undefined) return {};
  const next: FeatureFlagsMap = { ...parseFeatureOverrides(current.featureOverrides) };
  for (const key of Object.values(FeatureFlag)) {
    const value = patch[key];
    if (typeof value === "boolean") next[key] = value;
  }
  await db
    .update(storeSettings)
    .set({ featureOverrides: next, updatedAt: new Date() })
    .where(eq(storeSettings.id, current.id));
  return next;
}

export function isFeatureDisabled(flags: FeatureFlagsMap, flag: FeatureFlag): boolean {
  return flags[flag] === true;
}
