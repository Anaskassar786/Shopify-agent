import { desc, eq, and } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { syncHistory, withStoreScope } from "@profit/db";
import { channelFor, NotificationService } from "@profit/notifications";
import type { PubSubPort } from "@profit/cache";
import { NotificationCategory, RealtimeEventKind, type RealtimeEvent, type SyncModule } from "@profit/types";
import type { Logger } from "@profit/logger";

/**
 * Live UX bridge (M3): the worker is the ONLY place durable sync outcomes
 * happen, so it owns the corresponding merchant-facing signals.
 * Noise discipline (P4 notification quality):
 *   - module SUCCESS  → socket event only (progress UIs), never a row;
 *   - module FAILURE on FINAL attempt → notification row + socket event;
 *   - full-run group completion → notification row + socket event (rare,
 *     onboarding-critical signal).
 */

export function publishRealtime(pubsub: PubSubPort, event: RealtimeEvent): Promise<void> {
  return pubsub.publish(channelFor(event.storeId), event);
}

export function emitSyncModuleCompleted(
  pubsub: PubSubPort,
  input: { storeId: string; module: SyncModule; runId: string; stats: Record<string, number> },
): Promise<void> {
  return publishRealtime(pubsub, {
    kind: RealtimeEventKind.SyncModuleCompleted,
    storeId: input.storeId,
    occurredAt: new Date().toISOString(),
    payload: { module: input.module, runId: input.runId, stats: input.stats },
  });
}

export async function notifySyncModuleFailed(
  deps: { db: ProfitDb; pubsub: PubSubPort; logger: Logger },
  input: { storeId: string; module: SyncModule; error: unknown },
): Promise<void> {
  const runId = await latestFailedRunId(deps.db, input.storeId, input.module);
  const errorMessage = input.error instanceof Error ? input.error.message : "unknown error";
  const service = new NotificationService(deps.db, deps.pubsub);
  await service.create(input.storeId, {
    category: NotificationCategory.System,
    title: `${input.module.toLowerCase()} sync failed`,
    body: `The ${input.module.toLowerCase()} data sync stopped after exhausting retries: ${errorMessage}. Check the sync status page; the next scheduled pass resumes automatically.`,
    actionUrl: "/settings/sync",
  });
  await publishRealtime(deps.pubsub, {
    kind: RealtimeEventKind.SyncModuleFailed,
    storeId: input.storeId,
    occurredAt: new Date().toISOString(),
    payload: { module: input.module, runId: runId ?? "", errorMessage },
  });
  deps.logger.warn(
    { storeId: input.storeId, module: input.module, runId },
    "sync.module.failed_notified",
  );
}

export async function notifyFullRunCompleted(
  deps: { db: ProfitDb; pubsub: PubSubPort; logger: Logger },
  input: { storeId: string; runGroupId: string; modulesCompleted: number },
): Promise<void> {
  const service = new NotificationService(deps.db, deps.pubsub);
  await service.create(input.storeId, {
    category: NotificationCategory.System,
    title: "Data sync complete",
    body: `All ${String(input.modulesCompleted)} data modules finished their full sync. Your dashboard, analytics and AI context are now running on live store data.`,
    actionUrl: "/dashboard",
  });
  await publishRealtime(deps.pubsub, {
    kind: RealtimeEventKind.SyncFullRunCompleted,
    storeId: input.storeId,
    occurredAt: new Date().toISOString(),
    payload: { runGroupId: input.runGroupId, modulesCompleted: input.modulesCompleted },
  });
}

/** Best-effort lookup of the FAILURE row runModuleSync just wrote (for deep links). */
export async function latestFailedRunId(
  db: ProfitDb,
  storeId: string,
  module: SyncModule,
): Promise<string | null> {
  try {
    return await withStoreScope(db, storeId, async (tx) => {
      const rows = await tx
        .select({ id: syncHistory.id })
        .from(syncHistory)
        .where(
          and(
            eq(syncHistory.storeId, storeId),
            eq(syncHistory.module, module),
            eq(syncHistory.status, "FAILED"),
          ),
        )
        .orderBy(desc(syncHistory.createdAt))
        .limit(1);
      return rows[0]?.id ?? null;
    });
  } catch {
    return null;
  }
}
