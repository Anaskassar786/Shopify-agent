import { sql as drizzleSql, type SQL } from "drizzle-orm";
import type { ProfitDb } from "./client";

/**
 * Tenant-scoped execution (I2 defense-in-depth layer 2: the DB backstop).
 *
 * Every tenant-scoped data-plane query runs inside a transaction that:
 *   1. assumes the restricted `profit_app` role (policies from migration 0002
 *      apply to this role only);
 *   2. pins `app.store_id` via set_config(..., is_local = true) so the RLS
 *      policy physically filters rows for this tenant only;
 *   3. executes the caller's unit of work;
 *   4. rolls both settings back automatically at COMMIT (SET LOCAL semantics).
 *
 * Platform operations (install/uninstall/GDPR erasure/migrations) use the
 * owner connection directly by design — they are few, audited, and live only
 * in the shopify module, never in merchant-facing controllers.
 */
export const APP_TENANT_ROLE = "profit_app";

export async function withStoreScope<T>(
  db: ProfitDb,
  storeId: string,
  work: (tx: ProfitDb) => Promise<T>,
): Promise<T> {
  // The drizzle transaction handle is driver-faithful; repositories accept the
  // same ProfitDb surface, so the cast stays internal to this helper.
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql.raw(`SET LOCAL ROLE ${APP_TENANT_ROLE}`));
    await tx.execute(drizzleSql`SELECT set_config('app.store_id', ${storeId}, true)`);
    return work(tx as unknown as ProfitDb);
  });
}

/**
 * Driver-agnostic raw executor. drizzle's `db.execute()` shape depends on the
 * driver (postgres-js returns a row array; PGlite returns `{ rows }`) — code
 * must never branch on that, so raw reads flow through here.
 */
export async function execRaw<TRow>(
  db: ProfitDb,
  query: SQL,
): Promise<TRow[]> {
  const result: unknown = await db.execute(query);
  if (Array.isArray(result)) return result as TRow[];
  const rows = (result as { rows?: TRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Read the active tenant inside a scoped transaction (repositories assert on
 * this in tests; production relies on the pin above).
 */
export async function currentScopedStoreId(tx: ProfitDb): Promise<string | null> {
  const rows = await execRaw<{ store_id: string }>(
    tx,
    drizzleSql`SELECT current_setting('app.store_id', true) AS store_id`,
  );
  const row = rows[0];
  return row && row.store_id !== "" ? row.store_id : null;
}
