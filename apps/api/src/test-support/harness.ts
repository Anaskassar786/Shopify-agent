import { createHmac, createSecretKey } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import type { Express } from "express";
import { SignJWT } from "jose";
import { vi } from "vitest";
import { MemoryCache, MemoryPubSub } from "@profit/cache";
import { NotificationService } from "@profit/notifications";
import { seedPlatformCatalogs, type ProfitDb } from "@profit/db";
import { createTestDatabase } from "@profit/db/testing";
import { JobPersistence, MemoryJobQueue } from "@profit/queue";
import {
  AiExecuteDiscountActionJob,
  AiExecuteEmailActionJob,
  AiRunJob,
} from "@profit/ai";
import {
  resolveStoreAdminContext,
  ShopifyEnsureWebhooksJob,
  SyncModuleJob,
  SyncStoreFullJob,
  WebhookProcessJob,
} from "@profit/sync";
import { ShopifyBillingProvider, type BillingChargeProvider } from "@profit/billing";
import { createApp } from "../app";
import { createSpaHandler } from "../static/spa";
import { legalRouter } from "../modules/legal/legal.router";
import { loadEnv, type Env } from "../config/env";
import { EncryptionService } from "@profit/crypto";
import { createLogger, type Logger } from "@profit/logger";
import { AuditService } from "../modules/audit/audit.service";
import { AuthService } from "../modules/auth/auth.service";
import { JwtService } from "../modules/auth/jwt.service";
import { authRouter } from "../modules/auth/auth.router";
import { HealthService } from "../modules/health/health.service";
import { ShopifyOauthService } from "../modules/shopify/oauth.service";
import { ShopifyWebhookService } from "../modules/shopify/webhooks/webhook.service";
import { shopifyRouter } from "../modules/shopify/shopify.router";
import { storeRouter } from "../modules/store/store.router";
import { syncRouter } from "../modules/sync/sync.router";
import { analyticsRouter } from "../modules/analytics/analytics.router";
import { auditLogsRouter } from "../modules/audit/audit.router";
import { subscriptionRouter } from "../modules/billing/subscription.router";
import { billingRouter } from "../modules/billing/billing.router";
import { engagementRouter } from "../modules/billing/engagement.router";
import { adminRouter } from "../modules/admin/admin.router";
import { notificationsRouter } from "../modules/notifications/notifications.router";
import { recommendationsRouter } from "../modules/ai/recommendations.router";
import { aiRouter } from "../modules/ai/ai.router";
import { automationRouter } from "../modules/ai/automation.router";
import { workflowsRouter } from "../modules/automation-center/workflows.router";
import { campaignsRouter } from "../modules/automation-center/campaigns.router";
import { exportsRouter } from "../modules/automation-center/exports.router";
import { supportRouter } from "../modules/automation-center/support.router";
import { trackingRouter } from "../modules/automation-center/tracking.router";
import { searchRouter } from "../modules/search/search.router";
import {
  customersRouter,
  inventoryRouter,
  ordersRouter,
  productsRouter,
} from "../modules/catalog/catalog.router";
import { createStoreCache } from "@profit/cache";

/**
 * Integration harness: the REAL app against a REAL Postgres engine (PGlite)
 * with the REAL migrations applied. The only stubbed boundary is the outbound
 * HTTP call to Shopify itself — everything in-process is production code.
 */

export const TEST_SHOP = "demo-store.myshopify.com";
export const API_KEY = "test_api_key";

/** M7 legal-plane identity fixtures (production wiring reads env instead). */
export const TEST_LEGAL_ENTITY = "Profit Tool AI Test Labs";
export const TEST_SUPPORT_EMAIL = "support@profittest.invalid";
export const API_SECRET = "test_api_secret";
export const APP_URL = "https://app.profit.test";
export const ACCESS_SECRET = "integration-access-secret";
/** M5: the harness admin panel key — tests authenticate with this exact value. */
export const PLATFORM_ADMIN_KEY = "test-platform-admin-key";
/** M6: deterministic tracking HMAC key shared by router + assertions. */
export const TRACKING_SECRET = "test-tracking-secret-0123456789abcdef";

export interface TestEnvironment {
  readonly app: Express;
  readonly db: ProfitDb;
  readonly env: Env;
  readonly logger: Logger;
  readonly encryption: EncryptionService;
  readonly authService: AuthService;
  readonly jwtService: JwtService;
  readonly queue: MemoryJobQueue;
  readonly cache: MemoryCache;
  readonly persistence: JobPersistence;
  /**
   * Drain the in-process queue. Handlers registered by the producer side
   * are no-ops (worker handlers live in apps/worker and are covered by its
   * suite); draining proves enqueue → persistence → lifecycle plumbing.
   */
  readonly settle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../packages/db/drizzle");
}

export interface TestEnvironmentOptions {
  /**
   * When set, the app is created with the production-shaped SPA mount (M7
   * wiring contract: apiV1 → spa → 404 envelope). Dist fixture is caller-built
   * (temp dir) so the web bundle is not a test dependency.
   */
  readonly spaDistDir?: string;
}

export async function buildTestEnvironment(options: TestEnvironmentOptions = {}): Promise<TestEnvironment> {
  const testDb = await createTestDatabase(migrationsDir());
  const db = testDb.db;
  await seedPlatformCatalogs(db);

  const env = loadEnv({
    NODE_ENV: "test",
    PORT: "3999",
    APP_URL,
    DATABASE_URL: "postgres://pglite/in-process",
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_APP_URL: APP_URL,
    SHOPIFY_SCOPES: "read_products,write_products,read_orders",
    SHOPIFY_API_VERSION: "2025-10",
    JWT_SECRET: ACCESS_SECRET,
    JWT_REFRESH_SECRET: "integration-refresh-secret",
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    LOG_LEVEL: "fatal",
  });

  const sink = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const logger = createLogger({ level: "fatal", service: "api-test", environment: "test", destination: sink });
  const pubsub = new MemoryPubSub();

  const encryption = EncryptionService.forTestKey(4242);
  const audit = new AuditService(db, logger);

  const cache = new MemoryCache();
  const queue = new MemoryJobQueue({ logger, concurrency: 8, dispatchIntervalMs: 2 });
  const persistence = new JobPersistence(db, logger);
  persistence.attach(queue);
  // Producer-side no-op consumers: queue plumbing is proven here; business
  // handlers are proven by the worker suite.
  queue.register(WebhookProcessJob, () => Promise.resolve());
  queue.register(SyncStoreFullJob, () => Promise.resolve());
  queue.register(SyncModuleJob, () => Promise.resolve());
  queue.register(ShopifyEnsureWebhooksJob, () => Promise.resolve());
  queue.register(AiRunJob, () => Promise.resolve());
  queue.register(AiExecuteEmailActionJob, () => Promise.resolve());
  queue.register(AiExecuteDiscountActionJob, () => Promise.resolve());
  // Webhook consumers run in the worker process (apps/worker registers the
  // real handler); the API harness mirrors the producer side of the boundary.
  queue.register(WebhookProcessJob, () => Promise.resolve());
  await queue.start();

  const enqueueWebhookProcess = async (storeId: string, webhookLogId: string): Promise<void> => {
    await persistence.enqueuePersistent(
      queue,
      WebhookProcessJob,
      { storeId, webhookLogId },
      { jobId: `webhook:${webhookLogId}` },
    );
  };

  const oauth = new ShopifyOauthService({
    db,
    encryption,
    config: {
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      appUrl: APP_URL,
      scopes: "read_products,write_products,read_orders",
      apiVersion: "2025-10",
    },
    audit,
    logger,
    afterProvision: async (storeId) => {
      const runGroupId = `rg-${storeId.slice(0, 8)}`;
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
    },
  });
  const webhooks = new ShopifyWebhookService({
    db,
    audit,
    logger,
    apiSecret: API_SECRET,
    enqueueWebhookProcess,
  });
  const jwt = new JwtService({ accessSecret: ACCESS_SECRET, accessTtlSeconds: 900 });
  const auth = new AuthService({
    db,
    jwt,
    oauth,
    audit,
    logger,
    encryption,
    shopifyTokenConfig: { apiKey: API_KEY, apiSecret: API_SECRET },
    refreshTtlSeconds: 30 * 24 * 3600,
  });
  const healthService = new HealthService({
    version: "test",
    dbProbe: async () => testDb.client.query("SELECT 1"),
  });

  // M5: same wiring as the production composition root — one shared
  // NotificationService, and a provider factory that resolves the REAL
  // encrypted offline token (only the Shopify HTTP edge is stubbed).
  const notifications = new NotificationService(db, pubsub);
  const providerFor = async (storeId: string): Promise<BillingChargeProvider | null> => {
    try {
      const admin = await resolveStoreAdminContext(db, encryption, storeId);
      return new ShopifyBillingProvider(admin.shopDomain, admin.accessToken, "2025-10");
    } catch {
      return null;
    }
  };

  const spa =
    options.spaDistDir !== undefined
      ? createSpaHandler({ distDir: options.spaDistDir, shopifyApiKey: API_KEY, logger })
      : undefined;

  const app = createApp({
    env,
    logger,
    healthService,
    ...(spa !== undefined ? { spa } : {}),
    routers: {
      shopify: shopifyRouter({ oauth, webhooks, logger }),
      legal: legalRouter({
        cache,
        entityName: TEST_LEGAL_ENTITY,
        supportEmail: TEST_SUPPORT_EMAIL,
        appUrl: APP_URL,
      }),
      apiV1: {
        auth: authRouter({ auth, jwt, cache }),
        store: storeRouter({ db, jwt, audit, logger, supportEmail: TEST_SUPPORT_EMAIL }),
        sync: syncRouter({ db, jwt, queue, persistence, cache }),
        analytics: analyticsRouter({
          db,
          jwt,
          storeCacheFor: (storeId) => createStoreCache(cache, storeId, logger),
        }),
        products: productsRouter({ db, jwt }),
        customers: customersRouter({ db, jwt }),
        orders: ordersRouter({ db, jwt }),
        inventory: inventoryRouter({ db, jwt }),
        notifications: notificationsRouter({ db, jwt, notifications }),
        search: searchRouter({ db, jwt }),
        auditLogs: auditLogsRouter({ db, jwt }),
        subscription: subscriptionRouter({ db, jwt, audit, logger }),
        recommendations: recommendationsRouter({ db, jwt, queue, persistence, audit, logger }),
        ai: aiRouter({ db, jwt }),
        automation: automationRouter({ db, jwt }),
        billing: billingRouter({
          db,
          jwt,
          audit,
          notifications,
          logger,
          providerFor,
          billingTest: true,
          appUrl: APP_URL,
          shopifyApiKey: API_KEY,
        }),
        engagement: engagementRouter({ db, jwt }),
        admin: adminRouter({ db, platformAdminKey: PLATFORM_ADMIN_KEY, audit, queue, persistence }),
        // M6 Automation Center plane — same wiring parity as production.
        workflows: workflowsRouter({ db, jwt, audit, queue, persistence, logger }),
        campaigns: campaignsRouter({ db, jwt, audit, queue, persistence, logger }),
        exports: exportsRouter({ db, jwt, audit, queue, persistence, logger }),
        support: supportRouter({ db, jwt, audit }),
        tracking: trackingRouter({ db, logger, trackingSecret: TRACKING_SECRET }),
      },
    },
  });

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 20; round += 1) {
      const idle = await queue.waitForIdle(10_000);
      if (idle) {
        await new Promise((r) => setTimeout(r, 25));
        if (await queue.waitForIdle(1_000)) return;
      }
    }
    throw new Error("queue did not settle");
  };

  return {
    app,
    db,
    env,
    logger,
    encryption,
    authService: auth,
    jwtService: jwt,
    queue,
    cache,
    persistence,
    settle,
    close: async () => {
      await queue.close();
      await testDb.close();
    },
  };
}

// ── Shopify session-token signing (the Shopify side of the boundary) ────────

export async function signShopifySessionToken(user: {
  shopifyUserId: string;
  sessionId?: string;
  shop?: string;
}): Promise<string> {
  const shop = user.shop ?? TEST_SHOP;
  const secret = createSecretKey(Buffer.from(API_SECRET, "utf8"));
  return new SignJWT({
    sub: user.shopifyUserId,
    sid: user.sessionId ?? "sid-1",
    dest: `https://${shop}`,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(`https://${shop}/admin`)
    .setAudience(API_KEY)
    .setIssuedAt()
    .setExpirationTime("300s")
    .sign(secret);
}

// ── Webhook signing (the Shopify side of the boundary) ──────────────────────

export function shopifyWebhookHeaders(shop: string, topic: string, deliveryId: string, rawBody: Buffer) {
  return {
    "x-shopify-shop-domain": shop,
    "x-shopify-topic": topic,
    "x-shopify-webhook-id": deliveryId,
    "x-shopify-hmac-sha256": createHmac("sha256", API_SECRET).update(rawBody).digest("base64"),
  };
}

// ── OAuth callback signing (the Shopify side of the boundary) ───────────────

export function signOauthCallback(params: Record<string, string>): Record<string, string> {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key]).replace(/%/g, "%25").replace(/&/g, "%26")}`)
    .join("&");
  const hmac = createHmac("sha256", API_SECRET).update(canonical).digest("hex");
  return { ...params, hmac };
}

// ── Outbound Shopify API stub (network boundary — the ONLY stub allowed) ────

/** Shopify Billing wire state — tests mutate it to drive decision outcomes. */
export interface BillingStubState {
  /** What Shopify's currentAppInstallation returns (PENDING after create, by design). */
  liveSubscriptions: { id: string; name: string; status: string; test: boolean }[];
  /** Monotonic charge ids handed out by appSubscriptionCreate. */
  nextChargeSeq: number;
  /** userErrors simulation for appSubscriptionCreate. */
  failCreate: boolean;
  /** Status reported by appSubscriptionCancel. */
  cancelStatus: string;
}

export function createBillingStubState(): BillingStubState {
  return { liveSubscriptions: [], nextChargeSeq: 900_001, failCreate: false, cancelStatus: "CANCELLED" };
}

export function stubShopifyHttp(overrides: {
  accountOwner?: boolean;
  shopName?: string;
  failWebhookRegistration?: boolean;
  /**
   * M5 billing wire behavior. Pass createBillingStubState() and mutate it to
   * drive the merchant's decision (status flips live in Shopify, never in URL).
   */
  billing?: BillingStubState;
} = {}) {
  const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};

    if (url.endsWith("/admin/oauth/access_token")) {
      if (body["grant_type"] === "urn:ietf:params:oauth:grant-type:token-exchange") {
        // Identity is shop-scoped, just like real Shopify installed users —
        // unique-email collisions across tenants must be impossible to fake.
        const shopDomain =
          /https:\/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)/.exec(url)?.[1] ?? TEST_SHOP;
        const handle = shopDomain.replace(".myshopify.com", "");
        return jsonResponse({
          access_token: "shput_online_token_x",
          scope: "read_products,write_products,read_orders",
          expires_in: 3600,
          associated_user: {
            id: 42,
            email: `owner@${handle}.example`,
            first_name: "Ada",
            last_name: "Merchant",
            account_owner: overrides.accountOwner ?? true,
            locale: "en",
          },
        });
      }
      return jsonResponse({
        access_token: "fixture_offline_access_token_value",
        scope: "read_products,write_products,read_orders",
      });
    }

    if (url.includes("/admin/api/") && url.endsWith("/graphql.json")) {
      const query = String(body["query"] ?? "");
      if (query.includes("ShopProfile")) {
        const shopDomain =
          /https:\/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)/.exec(url)?.[1] ?? TEST_SHOP;
        return jsonResponse({
          data: {
            shop: {
              id: `gid://shopify/Shop/${shopDomain === TEST_SHOP ? 777001 : 888002}`,
              name: overrides.shopName ?? (shopDomain === TEST_SHOP ? "Demo Store" : "Second Store"),
              email: "contact@demo-store.example",
              currencyCode: "USD",
              ianaTimezone: "America/New_York",
              myshopifyDomain: shopDomain,
            },
          },
        });
      }
      if (query.includes("webhookSubscriptionCreate")) {
        if (overrides.failWebhookRegistration === true) {
          return jsonResponse({ errors: [{ message: "forced registration failure" }] });
        }
        return jsonResponse({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: "gid://shopify/WebhookSubscription/1", topic: "APP_UNINSTALLED" },
              userErrors: [],
            },
          },
        });
      }
      // ── M5 Billing wire ──────────────────────────────────────────────────
      if (query.includes("appSubscriptionCreate")) {
        const billing = overrides.billing;
        if (billing === undefined || billing.failCreate) {
          return jsonResponse({
            data: {
              appSubscriptionCreate: {
                appSubscription: null,
                confirmationUrl: null,
                userErrors: [{ field: ["plan"], message: "billing wire not stubbed for this test" }],
              },
            },
          });
        }
        const chargeId = String(billing.nextChargeSeq);
        billing.nextChargeSeq += 1;
        // Shopify-faithful: a fresh charge waits for the merchant's decision.
        billing.liveSubscriptions.push({
          id: `gid://shopify/AppSubscription/${chargeId}`,
          name: "PROFIT TOOL AI charge (stubbed wire)",
          status: "PENDING",
          test: true,
        });
        const shopDomain =
          /https:\/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)/.exec(url)?.[1] ?? TEST_SHOP;
        return jsonResponse({
          data: {
            appSubscriptionCreate: {
              appSubscription: { id: `gid://shopify/AppSubscription/${chargeId}` },
              confirmationUrl: `https://${shopDomain}/admin/charges/${chargeId}/confirm_recurring_application_charge`,
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("appSubscriptionCancel")) {
        const billing = overrides.billing;
        const variables = (body["variables"] ?? {}) as Record<string, unknown>;
        const gid = typeof variables["id"] === "string" ? variables["id"] : "";
        const suffix = gid.split("/").pop() ?? "";
        if (billing !== undefined) {
          const live = billing.liveSubscriptions.find((sub) => sub.id === gid || sub.id.endsWith(`/${suffix}`));
          if (live !== undefined) live.status = billing.cancelStatus;
        }
        return jsonResponse({
          data: {
            appSubscriptionCancel: {
              appSubscription: {
                id: gid === "" ? "gid://shopify/AppSubscription/unknown" : gid,
                status: billing?.cancelStatus ?? "CANCELLED",
              },
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("currentAppInstallation")) {
        return jsonResponse({
          data: {
            currentAppInstallation: {
              activeSubscriptions: overrides.billing?.liveSubscriptions ?? [],
            },
          },
        });
      }
    }

    return jsonResponse({ error: `unstubbed call: ${url}` }, 500);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
