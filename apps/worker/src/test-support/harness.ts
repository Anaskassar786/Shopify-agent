import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { MemoryCache, MemoryPubSub } from "@profit/cache";
import { EncryptionService } from "@profit/crypto";
import type { DbClient, ProfitDb } from "@profit/db";
import {
  plans,
  seedPlatformCatalogs,
  shopifySessions,
  stores,
  subscriptions,
  webhookLogs,
} from "@profit/db";
import { createTestDatabase } from "@profit/db/testing";
import { createLogger, type Logger } from "@profit/logger";
import { JobPersistence, MemoryJobQueue } from "@profit/queue";
import {
  PlanCode,
  SubscriptionStatus,
  type BillingInterval,
} from "@profit/types";
import { loadWorkerEnv, type WorkerEnv } from "../config/env";
import { registerWorkerJobs } from "../server";
import type { AiProvider, EmailSender } from "@profit/ai";
import type { WorkerDeps } from "../handlers/deps";

/**
 * Worker integration harness: real queue port (in-process driver), real
 * handlers, real Postgres (PGlite) with real migrations, real AES-GCM token
 * encryption. Only the outbound Shopify HTTP boundary is stubbed — the exact
 * same discipline as the API harness.
 */

export const WORKER_TEST_SHOP = "worker-store.myshopify.com";
export const WORKER_TEST_TOKEN = "fixture_worker_offline_token";

const DAY_MS = 24 * 60 * 60_000;

export interface SeedHarnessSubscriptionOptions {
  readonly planCode?: PlanCode;
  readonly status?: SubscriptionStatus;
  readonly shopifyChargeId?: string | null;
  readonly billingInterval?: BillingInterval | null;
  readonly trialEndsAt?: Date | null;
  readonly graceEndsAt?: Date | null;
  readonly currentPeriodStart?: Date | null;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelledAt?: Date | null;
  readonly createdAt?: Date;
}

export interface WorkerTestEnvironment {
  readonly db: ProfitDb;
  readonly deps: WorkerDeps;
  readonly queue: MemoryJobQueue;
  readonly cache: MemoryCache;
  readonly pubsub: MemoryPubSub;
  readonly logger: Logger;
  readonly env: WorkerEnv;
  readonly storeId: string;
  /** Enqueue + settle helpers. */
  readonly settle: () => Promise<void>;
  readonly insertWebhookLog: (topic: string, payload: Record<string, unknown>, deliveryId?: string) => Promise<string>;
  readonly cacheVersion: (domain: string) => Promise<number>;
  readonly close: () => Promise<void>;
}

export interface WorkerHarnessOptions {
  /** Optional per-test payload routing for the fetch stub. */
  readonly fetchRouter?: (url: string, body: unknown) => Response | Promise<Response>;
  /** AI plane overrides — default null exercises the failsafe path. */
  readonly aiProvider?: AiProvider | null;
  readonly emailSender?: EmailSender | null;
}

/**
 * M5 gate fixture: give a store a subscription row so the entitlement gates
 * (nightly-tick fan-out, email-execution preflight, execution metering) pass.
 * Production installs ALWAYS carry a trial row — OAuth provisioning creates it
 * inside the install transaction, so a store without one is intentionally
 * revenue-blocked; suites exercising revenue paths must seed this.
 * Defaults to a fresh STARTER trial (3 days remaining).
 */
export async function seedHarnessSubscription(
  db: ProfitDb,
  storeId: string,
  options: SeedHarnessSubscriptionOptions = {},
): Promise<string> {
  const status = options.status ?? SubscriptionStatus.Trialing;
  const planCode = options.planCode ?? PlanCode.Starter;
  await seedPlatformCatalogs(db);
  const planRows = await db.select({ id: plans.id, code: plans.code }).from(plans);
  const plan = planRows.find((row) => row.code === planCode);
  if (plan === undefined) throw new Error(`plan not seeded: ${planCode}`);
  const trialDefault = status === SubscriptionStatus.Trialing || status === SubscriptionStatus.ChargePending
    ? new Date(Date.now() + 3 * DAY_MS)
    : null;
  const rows = await db
    .insert(subscriptions)
    .values({
      storeId,
      planId: plan.id,
      status,
      shopifyChargeId: options.shopifyChargeId ?? null,
      billingInterval: options.billingInterval ?? null,
      trialEndsAt: options.trialEndsAt !== undefined ? options.trialEndsAt : trialDefault,
      graceEndsAt: options.graceEndsAt ?? null,
      currentPeriodStart: options.currentPeriodStart ?? null,
      currentPeriodEnd: options.currentPeriodEnd ?? null,
      cancelledAt: options.cancelledAt ?? null,
      ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
    })
    .returning({ id: subscriptions.id });
  return rows[0]!.id;
}

export function jsonResponse(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export async function buildWorkerTestEnvironment(
  options: WorkerHarnessOptions = {},
): Promise<WorkerTestEnvironment> {
  const here = dirname(fileURLToPath(import.meta.url));
  const testDb = await createTestDatabase(resolve(here, "../../../../packages/db/drizzle"));
  const db = testDb.db;

  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const logger = createLogger({ level: "fatal", service: "worker-test", environment: "test", destination: sink });

  const env = loadWorkerEnv({
    NODE_ENV: "test",
    PORT: "3199",
    DATABASE_URL: "postgres://pglite/in-process",
    ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
    SHOPIFY_APP_URL: "https://app.profit.test",
    SHOPIFY_API_VERSION: "2025-10",
    LOG_LEVEL: "fatal",
    SHOPIFY_HTTP_MAX_RETRIES: "1",
    SHOPIFY_HTTP_BASE_DELAY_MS: "2",
  });

  const encryption = EncryptionService.forTestKey(777);
  const queue = new MemoryJobQueue({ logger, concurrency: 8, dispatchIntervalMs: 2 });
  const cache = new MemoryCache();
  const pubsub = new MemoryPubSub();
  const persistence = new JobPersistence(db, logger);
  // PGlite drives the same ProfitDb surface; the pool handle is only used by
  // the health probe, which the harness replaces.
  const dbHandle = { db, sql: null, close: () => Promise.resolve() } as unknown as DbClient;
  const deps: WorkerDeps = {
    env, logger, db: dbHandle, queue, persistence, cache, pubsub, encryption,
    aiProvider: options.aiProvider ?? null,
    emailSender: options.emailSender ?? null,
  };

  persistence.attach(queue);
  registerWorkerJobs(deps);
  await queue.start();

  // A ready-to-sync store with an OFFLINE session (token encrypted for real).
  const storeRows = await db
    .insert(stores)
    .values({ shopDomain: WORKER_TEST_SHOP, name: "Worker Store" })
    .returning({ id: stores.id });
  const storeId = storeRows[0]!.id;
  await db.insert(shopifySessions).values({
    storeId,
    sessionType: "OFFLINE",
    accessTokenEncrypted: encryption.encrypt(WORKER_TEST_TOKEN),
    scopes: ["read_products", "read_orders"],
  });

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 20; round += 1) {
      const idle = await queue.waitForIdle(10_000);
      if (idle) {
        // Event persistence is fire-and-forget: one beat to flush.
        await new Promise((r) => setTimeout(r, 25));
        if (await queue.waitForIdle(1_000)) return;
      }
    }
    throw new Error("queue did not settle");
  };

  const insertWebhookLog = async (
    topic: string,
    payload: Record<string, unknown>,
    deliveryId = `delivery-${String(Date.now())}`,
  ): Promise<string> => {
    const rows = await db
      .insert(webhookLogs)
      .values({ storeId, topic, shopifyWebhookId: deliveryId, payload, hmacValid: true })
      .returning({ id: webhookLogs.id });
    return rows[0]!.id;
  };

  const cacheVersion = async (domain: string): Promise<number> =>
    (await cache.get<number>(`v:${storeId}:${domain}`)) ?? 0;

  return {
    db,
    deps,
    queue,
    cache,
    pubsub,
    logger,
    env,
    storeId,
    settle,
    insertWebhookLog,
    cacheVersion,
    close: async () => {
      await queue.close();
      await testDb.close();
    },
  };
}
