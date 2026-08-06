import { eq } from "@profit/db";
import { stores } from "@profit/db";
import { CacheInvalidator } from "@profit/cache";
import { StoreStatus, SyncMode, SyncModule } from "@profit/types";
import type { JobHandler } from "@profit/queue";
import {
  AnalyticsRefreshJob,
  ensureWebhookSubscriptions,
  REGISTERED_BUSINESS_TOPICS,
  refreshAnalytics,
  resolveStoreAdminContext,
  ShopifyEnsureWebhooksJob,
  SyncModuleJob,
  type ShopifyEnsureWebhooksPayload,
  type AnalyticsRefreshPayload,
} from "@profit/sync";
import { ShopifyWebhookTopic } from "@profit/types";
import { recordWorkerAudit } from "./audit";
import type { WorkerDeps } from "./deps";

/** analytics.refresh — set-based recompute (full or date-windowed). */
export function analyticsRefreshHandler(deps: WorkerDeps): JobHandler<AnalyticsRefreshPayload> {
  return async (ctx) => {
    const { storeId, dateFrom, dateTo } = ctx.payload;
    const window =
      dateFrom !== undefined && dateTo !== undefined
        ? { kind: "range" as const, dateFrom, dateTo }
        : { kind: "all" as const };
    const result = await refreshAnalytics(deps.db.db, storeId, window);
    await new CacheInvalidator(deps.cache, deps.logger).bump(storeId, "analytics");
    deps.logger.info({ storeId, window, ...result }, "analytics.refresh.completed");
  };
}

/** shopify.webhooks.ensure — reconcile subscriptions with the registered set. */
export function ensureWebhooksHandler(
  deps: WorkerDeps,
): JobHandler<ShopifyEnsureWebhooksPayload> {
  return async (ctx) => {
    const { storeId } = ctx.payload;
    const admin = await resolveStoreAdminContext(deps.db.db, deps.encryption, storeId);
    const appUrl = deps.env.SHOPIFY_APP_URL;
    if (appUrl === undefined) {
      throw new Error("SHOPIFY_APP_URL required to reconcile webhook subscriptions");
    }
    const topics = [ShopifyWebhookTopic.AppUninstalled, ...REGISTERED_BUSINESS_TOPICS];
    const result = await ensureWebhookSubscriptions(
      { ...admin, apiVersion: deps.env.SHOPIFY_API_VERSION },
      topics,
      `${appUrl}/shopify/webhooks`,
      deps.logger,
    );
    await recordWorkerAudit(deps.db.db, deps.logger, {
      storeId,
      action: "shopify.webhooks.reconciled",
      entityType: "store",
      entityId: storeId,
      result: "SUCCESS",
      metadata: {
        created: [...result.created],
        updated: [...result.updated],
        existingCount: result.existing.length,
      },
    });
  };
}

/** Modules that run incremental passes on the hourly tick. */
const HOURLY_INCREMENTAL_MODULES: readonly SyncModule[] = [
  SyncModule.Products,
  SyncModule.Customers,
  SyncModule.Orders,
  SyncModule.Collections,
  SyncModule.Discounts,
  // M4: checkouts ride the hourly pass — near-real-time abandonment detection.
  SyncModule.Checkouts,
];

async function enqueueForAllActiveStores(
  deps: WorkerDeps,
  act: (storeId: string) => Promise<void>,
): Promise<number> {
  const activeStores = await deps.db.db
    .select({ id: stores.id })
    .from(stores)
    .where(eq(stores.status, StoreStatus.Active));
  for (const store of activeStores) {
    await act(store.id);
  }
  return activeStores.length;
}

/** sync.scheduled-tick — hourly incremental sync for all active stores. */
export function syncScheduledTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const tick = new Date().toISOString().slice(0, 13); // hourly identity
    const count = await enqueueForAllActiveStores(deps, async (storeId) => {
      for (const module of HOURLY_INCREMENTAL_MODULES) {
        await deps.persistence.enqueuePersistent(
          deps.queue,
          SyncModuleJob,
          { storeId, module, mode: SyncMode.Scheduled },
          { jobId: `sync:scheduled:${tick}:${storeId}:${module}` },
        );
      }
    });
    deps.logger.info({ stores: count, tick }, "sync.scheduled_tick.fanned_out");
  };
}

/** analytics.nightly-tick — full-window aggregate recompute for all stores. */
export function analyticsNightlyTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const day = new Date().toISOString().slice(0, 10);
    const count = await enqueueForAllActiveStores(deps, async (storeId) => {
      await deps.persistence.enqueuePersistent(
        deps.queue,
        AnalyticsRefreshJob,
        { storeId },
        { jobId: `analytics:nightly:${day}:${storeId}` },
      );
    });
    deps.logger.info({ stores: count, day }, "analytics.nightly_tick.fanned_out");
  };
}

/**
 * maintenance.daily-tick — daily correctness pass: webhook reconciliation plus
 * FULL syncs of the modules that cannot do watermark-incremental passes.
 */
export function maintenanceDailyTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const day = new Date().toISOString().slice(0, 10);
    const count = await enqueueForAllActiveStores(deps, async (storeId) => {
      await deps.persistence.enqueuePersistent(
        deps.queue,
        ShopifyEnsureWebhooksJob,
        { storeId },
        { jobId: `maintenance:webhooks:${day}:${storeId}` },
      );
      for (const module of [SyncModule.Inventory, SyncModule.Metafields] as const) {
        await deps.persistence.enqueuePersistent(
          deps.queue,
          SyncModuleJob,
          { storeId, module, mode: SyncMode.Full },
          { jobId: `maintenance:full:${day}:${storeId}:${module}` },
        );
      }
    });
    deps.logger.info({ stores: count, day }, "maintenance.daily_tick.fanned_out");
  };
}
