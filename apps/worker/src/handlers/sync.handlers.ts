import { randomUUID } from "node:crypto";
import { CacheInvalidator } from "@profit/cache";
import { SyncMode, SyncModule } from "@profit/types";
import type { JobHandler } from "@profit/queue";
import {
  AnalyticsRefreshJob,
  FULL_SYNC_ORDER,
  modulesCompletedInGroup,
  runModuleSync,
  SyncModuleJob,
  type SyncModulePayload,
  type SyncStoreFullPayload,
} from "@profit/sync";
import { recordWorkerAudit } from "./audit";
import type { WorkerDeps } from "./deps";
import {
  emitSyncModuleCompleted,
  notifyFullRunCompleted,
  notifySyncModuleFailed,
} from "./realtime";

/** Modules whose completion requires an analytics recompute. */
const ANALYTICS_TOUCHING = new Set<SyncModule>([SyncModule.Orders, SyncModule.Customers]);

/** sync.store.full — durable fan-out into per-module jobs sharing a run group. */
export function fullSyncHandler(deps: WorkerDeps): JobHandler<SyncStoreFullPayload> {
  return async (ctx) => {
    const runGroupId = ctx.payload.runGroupId ?? randomUUID();
    const modules = ctx.payload.modules ?? FULL_SYNC_ORDER;
    deps.logger.info(
      { storeId: ctx.payload.storeId, runGroupId, modules, jobId: ctx.jobId },
      "sync.full.fanout",
    );
    for (const module of modules) {
      await deps.persistence.enqueuePersistent(
        deps.queue,
        SyncModuleJob,
        {
          storeId: ctx.payload.storeId,
          module,
          mode: SyncMode.Full,
          runGroupId,
          groupModules: modules,
        },
        { jobId: `sync:module:${ctx.payload.storeId}:${module}:${runGroupId}` },
      );
    }
  };
}

/**
 * sync.module — one full/incremental run of one module with checkpoints.
 * On completion: cache invalidation + analytics fan-in.
 */
export function moduleSyncHandler(deps: WorkerDeps): JobHandler<SyncModulePayload> {
  return async (ctx) => {
    const { storeId, module, mode, runGroupId, groupModules } = ctx.payload;
    let outcome;
    try {
      outcome = await runModuleSync(
      {
        db: deps.db.db,
        encryption: deps.encryption,
        apiVersion: deps.env.SHOPIFY_API_VERSION,
        logger: deps.logger,
        httpOptions: {
          maxRetries: deps.env.SHOPIFY_HTTP_MAX_RETRIES,
          baseDelayMs: deps.env.SHOPIFY_HTTP_BASE_DELAY_MS,
        },
      },
      { storeId, module, mode, ...(runGroupId !== undefined ? { runGroupId } : {}) },
      );
    } catch (error) {
      // Notify once — on the FINAL attempt (queue retries otherwise).
      if (ctx.attempt >= ctx.maxAttempts) {
        try {
          await notifySyncModuleFailed(
            { db: deps.db.db, pubsub: deps.pubsub, logger: deps.logger },
            { storeId, module, error },
          );
        } catch (notifyError) {
          deps.logger.error({ err: notifyError, storeId, module }, "sync.failure_notify.failed");
        }
      }
      throw error;
    }

    await emitSyncModuleCompleted(deps.pubsub, {
      storeId,
      module,
      runId: outcome.runId,
      stats: { ...outcome.stats },
    });

    const invalidator = new CacheInvalidator(deps.cache, deps.logger);
    const domains = ANALYTICS_TOUCHING.has(module)
      ? (["catalog", "analytics"] as const)
      : (["catalog"] as const);
    await invalidator.bumpAll(storeId, domains);

    await recordWorkerAudit(deps.db.db, deps.logger, {
      storeId,
      action: "sync.module.completed",
      entityType: "sync_run",
      entityId: outcome.runId,
      result: "SUCCESS",
      metadata: { module, mode, stats: outcome.stats, resumed: outcome.resumedFromCursor !== null },
    });

    // Analytics trigger: group fan-in (against the GROUP'S OWN module list —
    // partial full-sync groups complete correctly) OR standalone
    // orders/customers runs.
    const effectiveGroup = groupModules ?? FULL_SYNC_ORDER;
    let refreshAnalyticsNow = ANALYTICS_TOUCHING.has(module) && runGroupId === undefined;
    if (runGroupId !== undefined && !refreshAnalyticsNow) {
      const { pending } = await modulesCompletedInGroup(
        deps.db.db,
        storeId,
        runGroupId,
        effectiveGroup,
      );
      if (pending.length === 0) {
        refreshAnalyticsNow = true;
        deps.logger.info({ storeId, runGroupId }, "sync.full.fanin_complete");
        // The "your data is ready" merchant signal is reserved for TRUE full
        // runs (all modules) — partial groups refresh analytics silently.
        if (effectiveGroup.length === FULL_SYNC_ORDER.length) {
          try {
            await notifyFullRunCompleted(
              { db: deps.db.db, pubsub: deps.pubsub, logger: deps.logger },
              { storeId, runGroupId, modulesCompleted: FULL_SYNC_ORDER.length },
            );
          } catch (notifyError) {
            deps.logger.error({ err: notifyError, storeId, runGroupId }, "sync.fanin_notify.failed");
          }
        }
      }
    }
    if (refreshAnalyticsNow) {
      await deps.persistence.enqueuePersistent(
        deps.queue,
        AnalyticsRefreshJob,
        { storeId },
        {
          jobId: `analytics:after-sync:${storeId}:${outcome.runId}`,
        },
      );
      await invalidator.bump(storeId, "analytics");
    }
  };
}
