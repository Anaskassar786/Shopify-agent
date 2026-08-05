import type { Server } from "node:http";
import { createCache } from "@profit/cache";
import { EncryptionService } from "@profit/crypto";
import { createDbClient, probeDbConnection } from "@profit/db";
import { createLogger } from "@profit/logger";
import { createJobQueue, JobPersistence } from "@profit/queue";
import {
  AnalyticsNightlyTickJob,
  AnalyticsRefreshJob,
  MaintenanceDailyTickJob,
  SCHEDULES,
  ShopifyEnsureWebhooksJob,
  SyncModuleJob,
  SyncScheduledTickJob,
  SyncStoreFullJob,
  WebhookProcessJob,
} from "@profit/sync";
import { loadWorkerEnv, type WorkerEnv } from "./config/env";
import type { WorkerDeps } from "./handlers/deps";
import { analyticsRefreshHandler, analyticsNightlyTickHandler, ensureWebhooksHandler, maintenanceDailyTickHandler, syncScheduledTickHandler } from "./handlers/maintenance.handlers";
import { fullSyncHandler, moduleSyncHandler } from "./handlers/sync.handlers";
import { webhookProcessHandler } from "./handlers/webhook.handlers";
import { startHealthServer } from "./health/server";

export interface RunningWorker {
  readonly env: WorkerEnv;
  readonly deps: WorkerDeps;
  readonly healthServer: Server;
  readonly shutdown: () => Promise<void>;
}

/**
 * Register every data-plane handler on the queue (P3 worker taxonomy: sync,
 * webhooks, analytics, maintenance live HERE; ai/email/sms/discount workers
 * land with their milestones). Registration is a pure wiring function so the
 * test harness builds the identical graph against PGlite + in-process queue.
 */
export function registerWorkerJobs(deps: WorkerDeps): void {
  deps.queue.register(SyncStoreFullJob, fullSyncHandler(deps));
  deps.queue.register(SyncModuleJob, moduleSyncHandler(deps));
  deps.queue.register(WebhookProcessJob, webhookProcessHandler(deps));
  deps.queue.register(AnalyticsRefreshJob, analyticsRefreshHandler(deps));
  deps.queue.register(ShopifyEnsureWebhooksJob, ensureWebhooksHandler(deps));
  deps.queue.register(SyncScheduledTickJob, syncScheduledTickHandler(deps));
  deps.queue.register(AnalyticsNightlyTickJob, analyticsNightlyTickHandler(deps));
  deps.queue.register(MaintenanceDailyTickJob, maintenanceDailyTickHandler(deps));
}

/** Repeatable schedules (P3 scheduler). BullMQ dedupes by scheduleId; memory driver mirrors semantics. */
export async function registerWorkerSchedules(deps: WorkerDeps): Promise<void> {
  await deps.queue.upsertSchedule({
    scheduleId: "sync.scheduled-tick",
    definition: SyncScheduledTickJob,
    everyMs: deps.env.SYNC_INCREMENTAL_INTERVAL_MS,
    payload: {},
  });
  await deps.queue.upsertSchedule({
    scheduleId: "analytics.nightly-tick",
    definition: AnalyticsNightlyTickJob,
    everyMs: deps.env.ANALYTICS_REFRESH_INTERVAL_MS,
    payload: {},
  });
  await deps.queue.upsertSchedule({
    scheduleId: "maintenance.daily-tick",
    definition: MaintenanceDailyTickJob,
    everyMs: SCHEDULES.webhookEnsureEveryMs,
    payload: {},
  });
}

export async function startWorker(): Promise<RunningWorker> {
  const env = loadWorkerEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: "worker", environment: env.NODE_ENV });

  if (env.DATABASE_URL === undefined || env.ENCRYPTION_KEY === undefined) {
    throw new Error("worker requires DATABASE_URL and ENCRYPTION_KEY to start");
  }

  const db = createDbClient({ url: env.DATABASE_URL, maxConnections: 8 });
  const encryption = EncryptionService.create(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
  const cache = createCache({ logger, redisUrl: env.REDIS_URL });
  const queue = createJobQueue({
    logger,
    redisUrl: env.REDIS_URL,
    concurrency: env.WORKER_CONCURRENCY,
  });
  const persistence = new JobPersistence(db.db, logger);
  const deps: WorkerDeps = { env, logger, db, queue, persistence, cache, encryption };

  persistence.attach(queue);
  registerWorkerJobs(deps);
  await queue.start();

  let queueStarted = true;
  const healthServer = startHealthServer({
    logger,
    port: env.PORT,
    probes: {
      database: async () => {
        await probeDbConnection(db.sql);
      },
      queueStarted: () => queueStarted,
    },
  });

  await registerWorkerSchedules(deps);
  logger.info({ port: env.PORT, concurrency: env.WORKER_CONCURRENCY }, "worker.started");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    queueStarted = false;
    logger.info("worker.shutdown.started");
    await new Promise<void>((resolve) => {
      healthServer.close(() => resolve());
    });
    await queue.close();
    await cache.close();
    await db.close();
    logger.info("worker.shutdown.complete");
  };

  process.once("SIGTERM", () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, "worker.shutdown.failed");
      process.exitCode = 1;
    });
  });
  process.once("SIGINT", () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, "worker.shutdown.failed");
      process.exitCode = 1;
    });
  });

  return { env, deps, healthServer, shutdown };
}
