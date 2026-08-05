import { z } from "zod";
import { QueueName, SyncMode, SyncModule } from "@profit/types";
import type { JobDefinition } from "@profit/queue";

/**
 * Data-plane job contracts (P3 BullMQ workers: sync + analytics are first in
 * the spec's worker list). Definitions are shared verbatim between the API
 * (producer: intake + manual triggers + OAuth hook) and the worker
 * (consumer), so payload drift between services is a compile error, not an
 * incident. Every payload carries storeId (except platform-wide ticks) —
 * tenancy is explicit at the transport layer too.
 */

const syncModuleSchema = z.enum([
  SyncModule.Products,
  SyncModule.Customers,
  SyncModule.Orders,
  SyncModule.Inventory,
  SyncModule.Collections,
  SyncModule.Discounts,
  SyncModule.Metafields,
]);

const syncModeSchema = z.enum([
  SyncMode.Full,
  SyncMode.Incremental,
  SyncMode.Manual,
  SyncMode.Scheduled,
]);

export interface SyncStoreFullPayload {
  readonly storeId: string;
  readonly modules?: readonly z.infer<typeof syncModuleSchema>[] | undefined;
  readonly runGroupId?: string | undefined;
}

export const SyncStoreFullJob: JobDefinition<SyncStoreFullPayload> = {
  name: "sync.store.full",
  queue: QueueName.Sync,
  schema: z.object({
    storeId: z.string().uuid(),
    modules: z.array(syncModuleSchema).min(1).optional(),
    runGroupId: z.string().uuid().optional(),
  }),
  attempts: 2,
  backoffBaseMs: 5_000,
  timeoutMs: 10 * 60_000,
};

export interface SyncModulePayload {
  readonly storeId: string;
  readonly module: SyncModule;
  readonly mode: (typeof SyncMode)[keyof typeof SyncMode];
  readonly runGroupId?: string | undefined;
}

export const SyncModuleJob: JobDefinition<SyncModulePayload> = {
  name: "sync.module",
  queue: QueueName.Sync,
  schema: z.object({
    storeId: z.string().uuid(),
    module: syncModuleSchema,
    mode: syncModeSchema,
    runGroupId: z.string().uuid().optional(),
  }),
  attempts: 5,
  backoffBaseMs: 5_000,
  timeoutMs: 15 * 60_000,
};

export interface WebhookProcessPayload {
  readonly storeId: string;
  readonly webhookLogId: string;
}

export const WebhookProcessJob: JobDefinition<WebhookProcessPayload> = {
  name: "webhook.process",
  queue: QueueName.Sync,
  schema: z.object({
    storeId: z.string().uuid(),
    webhookLogId: z.string().uuid(),
  }),
  attempts: 5,
  backoffBaseMs: 2_500,
  timeoutMs: 60_000,
};

export interface AnalyticsRefreshPayload {
  readonly storeId: string;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
}

export const AnalyticsRefreshJob: JobDefinition<AnalyticsRefreshPayload> = {
  name: "analytics.refresh",
  queue: QueueName.Analytics,
  schema: z.object({
    storeId: z.string().uuid(),
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  attempts: 3,
  backoffBaseMs: 10_000,
  timeoutMs: 10 * 60_000,
};

export interface ShopifyEnsureWebhooksPayload {
  readonly storeId: string;
}

export const ShopifyEnsureWebhooksJob: JobDefinition<ShopifyEnsureWebhooksPayload> = {
  name: "shopify.webhooks.ensure",
  queue: QueueName.Sync,
  schema: z.object({ storeId: z.string().uuid() }),
  attempts: 5,
  backoffBaseMs: 15_000,
  timeoutMs: 5 * 60_000,
};

/** Platform-wide ticks (the workers' schedulers — P3 "scheduled jobs"). */
export const SyncScheduledTickJob: JobDefinition<Record<string, never>> = {
  name: "sync.scheduled-tick",
  queue: QueueName.Sync,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 5 * 60_000,
};

export const AnalyticsNightlyTickJob: JobDefinition<Record<string, never>> = {
  name: "analytics.nightly-tick",
  queue: QueueName.Analytics,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 5 * 60_000,
};

/**
 * Daily platform maintenance: webhook subscription reconciliation, and FULL
 * syncs for the modules without `updated_at_min` support (inventory,
 * metafields) — their correctness rides on these full passes plus webhooks.
 */
export const MaintenanceDailyTickJob: JobDefinition<Record<string, never>> = {
  name: "maintenance.daily-tick",
  queue: QueueName.Cleanup,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 10 * 60_000,
};

/** Cadence constants — one place, env-overridable in the worker config. */
export const SCHEDULES = {
  incrementalSyncEveryMs: 60 * 60_000,
  analyticsRefreshEveryMs: 6 * 60 * 60_000,
  webhookEnsureEveryMs: 24 * 60 * 60_000,
} as const;
