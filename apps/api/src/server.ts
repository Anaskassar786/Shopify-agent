import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { Router } from "express";
import { createCache, createStoreCache } from "@profit/cache";
import { createDbClient, probeDbConnection, type DbClient } from "@profit/db";
import { Environment } from "@profit/types";
import { createJobQueue, JobPersistence } from "@profit/queue";
import { ShopifyEnsureWebhooksJob, SyncStoreFullJob, WebhookProcessJob } from "@profit/sync";
import { createApp, type AppRouters } from "./app";
import { loadEnv, requireEnv, type Env } from "./config/env";
import { EncryptionService } from "@profit/crypto";
import { createLogger, type Logger } from "@profit/logger";
import { AuditService } from "./modules/audit/audit.service";
import { AuthService } from "./modules/auth/auth.service";
import { JwtService } from "./modules/auth/jwt.service";
import { authRouter } from "./modules/auth/auth.router";
import { HealthService } from "./modules/health/health.service";
import { ShopifyOauthService } from "./modules/shopify/oauth.service";
import { ShopifyWebhookService } from "./modules/shopify/webhooks/webhook.service";
import { shopifyRouter } from "./modules/shopify/shopify.router";
import { storeRouter } from "./modules/store/store.router";
import { syncRouter } from "./modules/sync/sync.router";
import { analyticsRouter } from "./modules/analytics/analytics.router";
import {
  customersRouter,
  inventoryRouter,
  ordersRouter,
  productsRouter,
} from "./modules/catalog/catalog.router";

export interface RunningServer {
  readonly server: Server;
  readonly env: Env;
  readonly logger: Logger;
  readonly shutdown: () => Promise<void>;
}

const HOST = "0.0.0.0";

/**
 * Composition root (P1: dependency injection — modules never construct their
 * own clients). Everything is built here from validated env, wired into the
 * app, and owned through the shutdown lifecycle.
 */
export async function startServer(): Promise<RunningServer> {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    service: "api",
    environment: env.NODE_ENV,
  });

  const db: DbClient | undefined =
    env.DATABASE_URL !== undefined
      ? createDbClient({ url: env.DATABASE_URL, maxConnections: 10 })
      : undefined;
  if (db === undefined) {
    logger.warn("DATABASE_URL not configured — readiness will report the database as skipped");
  }

  const healthService = new HealthService({
    version: env.APP_VERSION,
    ...(db !== undefined ? { dbProbe: () => probeDbConnection(db.sql) } : {}),
  });

  const routers = buildRouters(env, logger, db);

  const app = createApp({ env, logger, healthService, routers });

  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(env.PORT, HOST, () => resolve(instance));
    instance.on("error", reject);
  });

  logger.info({ host: HOST, port: env.PORT, version: env.APP_VERSION }, "api.listening");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("api.shutdown.started");
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (db !== undefined) await db.close();
    logger.info("api.shutdown.complete");
  };

  process.once("SIGTERM", () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, "api.shutdown.failed");
      process.exitCode = 1;
    });
  });
  process.once("SIGINT", () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, "api.shutdown.failed");
      process.exitCode = 1;
    });
  });

  return { server, env, logger, shutdown };
}

function buildRouters(env: Env, logger: Logger, db: DbClient | undefined): AppRouters {
  const shopifyConfigured =
    db !== undefined &&
    env.SHOPIFY_API_KEY !== undefined &&
    env.SHOPIFY_API_SECRET !== undefined &&
    env.SHOPIFY_APP_URL !== undefined &&
    env.SHOPIFY_SCOPES !== undefined &&
    env.ENCRYPTION_KEY !== undefined;

  const authConfigured = shopifyConfigured && env.JWT_SECRET !== undefined;

  if (db === undefined) {
    // No database: API cannot serve tenant traffic — routers surface as 404 via
    // notFound; health endpoints remain the only functional surface (M0 mode).
    logger.warn("database not configured — auth/store/shopify routes disabled");
    return { apiV1: stubApiV1() };
  }

  const audit = new AuditService(db.db, logger);

  if (!shopifyConfigured || !authConfigured) {
    if (env.NODE_ENV === Environment.Production || env.NODE_ENV === Environment.Staging) {
      // Env superRefine already guarantees these in hosted envs; belt-and-braces
      // so a misconfigured prod never runs half-wired.
      throw new Error("shopify/auth configuration incomplete in hosted environment");
    }
    logger.warn("shopify credentials incomplete — /shopify/* and /api/v1/auth/* disabled (dev mode)");
    return { apiV1: stubApiV1() };
  }

  const encryption = EncryptionService.create(
    requireEnv(env, "ENCRYPTION_KEY"),
    env.ENCRYPTION_KEY_PREVIOUS,
  );

  // M2 data-plane producers: queue + cache + durable job mirror. Driver
  // selection happens inside the factories (Redis → BullMQ/RedisCache;
  // absent → in-process), never in business code.
  const cache = createCache({ logger, redisUrl: env.REDIS_URL });
  const queue = createJobQueue({ logger, redisUrl: env.REDIS_URL });
  const persistence = new JobPersistence(db.db, logger);

  const enqueueWebhookProcess = async (storeId: string, webhookLogId: string): Promise<void> => {
    await persistence.enqueuePersistent(
      queue,
      WebhookProcessJob,
      { storeId, webhookLogId },
      { jobId: `webhook:${webhookLogId}` },
    );
  };

  const afterStoreProvisioned = async (storeId: string): Promise<void> => {
    const runGroupId = randomUUID();
    await persistence.enqueuePersistent(
      queue,
      SyncStoreFullJob,
      { storeId, runGroupId },
      { jobId: `sync:full:${storeId}:${runGroupId}` },
    );
    await persistence.enqueuePersistent(
      queue,
      ShopifyEnsureWebhooksJob,
      { storeId },
      { jobId: `webhooks:ensure:${storeId}:${runGroupId}` },
    );
  };

  const oauth = new ShopifyOauthService({
    db: db.db,
    encryption,
    config: {
      apiKey: requireEnv(env, "SHOPIFY_API_KEY"),
      apiSecret: requireEnv(env, "SHOPIFY_API_SECRET"),
      appUrl: requireEnv(env, "SHOPIFY_APP_URL"),
      scopes: requireEnv(env, "SHOPIFY_SCOPES"),
      apiVersion: env.SHOPIFY_API_VERSION,
    },
    audit,
    logger,
    afterProvision: async (storeId) => {
      // A failed scheduling attempt must never break the install redirect —
      // the daily maintenance tick re-drives both jobs.
      try {
        await afterStoreProvisioned(storeId);
      } catch (error) {
        logger.error({ err: error, storeId }, "shopify.provision_fanout.failed");
      }
    },
  });
  const webhooks = new ShopifyWebhookService({
    db: db.db,
    audit,
    logger,
    apiSecret: requireEnv(env, "SHOPIFY_API_SECRET"),
    enqueueWebhookProcess,
  });
  const jwt = new JwtService({
    accessSecret: requireEnv(env, "JWT_SECRET"),
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
  });
  const auth = new AuthService({
    db: db.db,
    jwt,
    oauth,
    audit,
    logger,
    encryption,
    shopifyTokenConfig: {
      apiKey: requireEnv(env, "SHOPIFY_API_KEY"),
      apiSecret: requireEnv(env, "SHOPIFY_API_SECRET"),
    },
    refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
  });

  return {
    shopify: shopifyRouter({ oauth, webhooks, logger }),
    apiV1: {
      auth: authRouter({ auth, jwt }),
      store: storeRouter({ db: db.db, jwt }),
      sync: syncRouter({ db: db.db, jwt, queue, persistence, cache }),
      analytics: analyticsRouter({
        db: db.db,
        jwt,
        storeCacheFor: (storeId) => createStoreCache(cache, storeId, logger),
      }),
      products: productsRouter({ db: db.db, jwt }),
      customers: customersRouter({ db: db.db, jwt }),
      orders: ordersRouter({ db: db.db, jwt }),
      inventory: inventoryRouter({ db: db.db, jwt }),
    },
  };
}

/** Unwired-module routers: mounted paths stay absent → uniform 404 envelope. */
function stubApiV1(): AppRouters["apiV1"] {
  return {
    auth: Router(),
    store: Router(),
    sync: Router(),
    analytics: Router(),
    products: Router(),
    customers: Router(),
    orders: Router(),
    inventory: Router(),
  };
}
