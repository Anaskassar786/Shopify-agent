import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { PubSubPort } from "@profit/cache";
import { Router } from "express";
import { createCache, createPubSub, createStoreCache } from "@profit/cache";
import { NotificationService } from "@profit/notifications";
import { createDbClient, probeDbConnection, type DbClient } from "@profit/db";
import { EngagementEventKind, Environment } from "@profit/types";
import { createJobQueue, JobPersistence } from "@profit/queue";
import {
  resolveStoreAdminContext,
  ShopifyEnsureWebhooksJob,
  SyncStoreFullJob,
  WebhookProcessJob,
} from "@profit/sync";
import {
  EngagementService,
  ShopifyBillingProvider,
  type BillingChargeProvider,
} from "@profit/billing";
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
import { auditLogsRouter } from "./modules/audit/audit.router";
import { subscriptionRouter } from "./modules/billing/subscription.router";
import { billingRouter } from "./modules/billing/billing.router";
import { engagementRouter } from "./modules/billing/engagement.router";
import { adminRouter } from "./modules/admin/admin.router";
import { notificationsRouter } from "./modules/notifications/notifications.router";
import { recommendationsRouter } from "./modules/ai/recommendations.router";
import { aiRouter } from "./modules/ai/ai.router";
import { automationRouter } from "./modules/ai/automation.router";
import { searchRouter } from "./modules/search/search.router";
import { workflowsRouter } from "./modules/automation-center/workflows.router";
import { campaignsRouter } from "./modules/automation-center/campaigns.router";
import { exportsRouter } from "./modules/automation-center/exports.router";
import { supportRouter } from "./modules/automation-center/support.router";
import { trackingRouter } from "./modules/automation-center/tracking.router";
import { createRealtimeGateway } from "./modules/realtime/gateway";
import { createSpaHandler, mountSpa } from "./static/spa";
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

  const pubsub = createPubSub({ logger, redisUrl: env.REDIS_URL });
  const routers = buildRouters(env, logger, db, { pubsub });

  const app = createApp({ env, logger, healthService, routers });

  // M3: embedded web app hosting (no-op when the bundle is not present).
  const spa = createSpaHandler({
    distDir: env.WEB_DIST_DIR ?? new URL("../../web/dist", import.meta.url).pathname,
    shopifyApiKey: env.SHOPIFY_API_KEY,
    logger,
  });
  mountSpa(app, spa);

  // M3: realtime gateway — JWT-authed WS fan-out of tenant pub/sub events.
  const gateway = createRealtimeGateway({
    jwt: new JwtService({
      accessSecret: requireEnv(env, "JWT_SECRET"),
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    }),
    pubsub,
    logger,
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(env.PORT, HOST, () => resolve(instance));
    instance.on("error", reject);
  });

  gateway.attach(server);

  logger.info({ host: HOST, port: env.PORT, version: env.APP_VERSION, spa: spa.available }, "api.listening");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("api.shutdown.started");
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await gateway.close();
    await pubsub.close();
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

function buildRouters(
  env: Env,
  logger: Logger,
  db: DbClient | undefined,
  infra: { pubsub: PubSubPort },
): AppRouters {
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
      // M5 growth funnel step 1 (deduped per store): install = store connected.
      try {
        await new EngagementService(db.db).emit({ storeId, kind: EngagementEventKind.StoreConnected });
      } catch (error) {
        logger.warn({ err: error, storeId }, "engagement.store_connected.failed");
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

  // M5: ONE notification service shared by the notifications API and the
  // billing router (charge lifecycle alerts land in the same drawer).
  const notifications = new NotificationService(db.db, infra.pubsub);

  /**
   * M5 charge provider factory: resolves the store's OFFLINE token through the
   * established sync helper. Unavailability is TYPED (null) — routers answer
   * 503 BILLING_UNAVAILABLE, never a simulated charge.
   */
  const providerFor = async (storeId: string): Promise<BillingChargeProvider | null> => {
    try {
      const admin = await resolveStoreAdminContext(db.db, encryption, storeId);
      return new ShopifyBillingProvider(admin.shopDomain, admin.accessToken, env.SHOPIFY_API_VERSION);
    } catch (error) {
      logger.warn({ err: error, storeId }, "billing.provider.unavailable");
      return null;
    }
  };

  return {
    shopify: shopifyRouter({ oauth, webhooks, logger }),
    apiV1: {
      auth: authRouter({ auth, jwt }),
      store: storeRouter({ db: db.db, jwt, audit, logger }),
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
      notifications: notificationsRouter({ db: db.db, jwt, notifications }),
      search: searchRouter({ db: db.db, jwt }),
      auditLogs: auditLogsRouter({ db: db.db, jwt }),
      subscription: subscriptionRouter({
        db: db.db,
        jwt,
        audit,
        logger,
        defaultPlanCode: env.SHOPIFY_BILLING_PLAN,
      }),
      recommendations: recommendationsRouter({ db: db.db, jwt, queue, persistence, audit, logger }),
      ai: aiRouter({ db: db.db, jwt }),
      automation: automationRouter({ db: db.db, jwt }),
      billing: billingRouter({
        db: db.db,
        jwt,
        audit,
        notifications,
        logger,
        providerFor,
        billingTest: env.SHOPIFY_BILLING_TEST,
        appUrl: requireEnv(env, "SHOPIFY_APP_URL"),
        shopifyApiKey: env.SHOPIFY_API_KEY,
      }),
      engagement: engagementRouter({ db: db.db, jwt }),
      admin: adminRouter({
        db: db.db,
        platformAdminKey: env.PLATFORM_ADMIN_KEY,
        audit,
        queue,
        persistence,
      }),
      // M6 Automation Center plane (workflows + campaigns + exports + support
      // share the queue producers; tracking is the public HMAC-token surface).
      workflows: workflowsRouter({ db: db.db, jwt, audit, queue, persistence, logger }),
      campaigns: campaignsRouter({ db: db.db, jwt, audit, queue, persistence, logger }),
      exports: exportsRouter({ db: db.db, jwt, audit, queue, persistence, logger }),
      support: supportRouter({ db: db.db, jwt, audit }),
      tracking: trackingRouter({ db: db.db, logger, trackingSecret: env.TRACKING_SIGNING_SECRET }),
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
    notifications: Router(),
    search: Router(),
    auditLogs: Router(),
    subscription: Router(),
    recommendations: Router(),
    ai: Router(),
    automation: Router(),
    billing: Router(),
    engagement: Router(),
    admin: Router(),
    workflows: Router(),
    campaigns: Router(),
    exports: Router(),
    support: Router(),
    tracking: Router(),
  };
}
