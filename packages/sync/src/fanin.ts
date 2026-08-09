import { and, eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { syncHistory } from "@profit/db";
import { SyncStatus, type SyncModule } from "@profit/types";
import { FULL_SYNC_ORDER } from "./modules/index";

/**
 * Full-sync fan-in: `sync.store.full` fans out one `sync.module` job per
 * module sharing a runGroupId; every module completion re-checks the group,
 * and the LAST finisher triggers the analytics refresh. No central watcher,
 * no polling — race-free because completion is re-evaluated from the
 * database, not from process-local counters.
 */
export async function modulesCompletedInGroup(
  db: ProfitDb,
  storeId: string,
  runGroupId: string,
  modules: readonly SyncModule[] = FULL_SYNC_ORDER,
): Promise<{ completed: SyncModule[]; pending: SyncModule[] }> {
  const rows = await db
    .select({ module: syncHistory.module })
    .from(syncHistory)
    .where(
      and(
        eq(syncHistory.storeId, storeId),
        eq(syncHistory.runGroupId, runGroupId),
        eq(syncHistory.status, SyncStatus.Completed),
      ),
    );
  const done = new Set(rows.map((row) => row.module));
  const completed = modules.filter((module) => done.has(module));
  const pending = modules.filter((module) => !done.has(module));
  return { completed, pending };
}
