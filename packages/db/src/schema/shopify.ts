import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  SyncMode,
  SyncModule,
  SyncStatus,
  WebhookStatus,
} from "@profit/types";
import { baseColumns, enumToPgTuple } from "./_common";
import { stores } from "./merchant";

export const shopifySessionTypeEnum = pgEnum("shopify_session_type", [
  "OFFLINE",
  "ONLINE",
] as const);
export const webhookStatusEnum = pgEnum("webhook_status", enumToPgTuple(WebhookStatus));
export const syncModuleEnum = pgEnum("sync_module", enumToPgTuple(SyncModule));
export const syncModeEnum = pgEnum("sync_mode", enumToPgTuple(SyncMode));
export const syncStatusEnum = pgEnum("sync_status", enumToPgTuple(SyncStatus));

/**
 * Shopify access tokens — stored AES-256-GCM encrypted (P12: "encrypted storage",
 * "never expose to frontend"). OFFLINE token powers background sync/webhooks.
 */
export const shopifySessions = pgTable(
  "shopify_sessions",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    sessionType: shopifySessionTypeEnum("session_type").notNull(),
    /** AES-256-GCM payload: base64(iv || authTag || ciphertext). */
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_sessions_store_type_unique").on(
      table.storeId,
      table.sessionType,
    ),
  ],
);

/**
 * Every inbound webhook is persisted BEFORE processing (P2 pipeline). The unique
 * (store, topic, shopifyWebhookId) constraint is the duplicate-prevention
 * mechanism (P12): webhook retries replay safely as no-ops.
 */
export const webhookLogs = pgTable(
  "webhook_logs",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    topic: varchar("topic", { length: 128 }).notNull(),
    /** X-Shopify-Webhook-Id header — stable per delivery attempt chain. */
    shopifyWebhookId: varchar("shopify_webhook_id", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    hmacValid: boolean("hmac_valid").notNull(),
    status: webhookStatusEnum("status").notNull().default("RECEIVED"),
    errorMessage: text("error_message"),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("webhook_logs_delivery_unique").on(
      table.storeId,
      table.topic,
      table.shopifyWebhookId,
    ),
    index("webhook_logs_store_status_idx").on(table.storeId, table.status),
  ],
);

/**
 * Single-use OAuth state nonces (P5: replay attack prevention). A state is
 * minted at /shopify/install, must match at /shopify/callback within its TTL,
 * and is burned on first use — a replayed callback fails closed.
 * Pre-install by nature, so there is no store yet (documented exception).
 */
export const shopifyOauthStates = pgTable(
  "shopify_oauth_states",
  {
    ...baseColumns,
    state: varchar("state", { length: 128 }).notNull(),
    shopDomain: varchar("shop_domain", { length: 255 }).notNull(),
    grantScopes: text("grant_scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_oauth_states_state_unique").on(table.state),
    index("shopify_oauth_states_shop_idx").on(table.shopDomain),
  ],
);

/** One row per sync run (P2 sync engine: logs + resumable cursor checkpoints). */
export const syncHistory = pgTable(
  "sync_history",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    module: syncModuleEnum("module").notNull(),
    mode: syncModeEnum("mode").notNull(),
    status: syncStatusEnum("status").notNull().default("PENDING"),
    /** Shopify pagination cursor checkpoint — a failed sync resumes here. */
    cursor: text("cursor"),
    /** { processed, created, updated, failed, durationMs } — filled by the sync worker. */
    stats: jsonb("stats").notNull().default(sql`'{}'::jsonb`),
    retryCount: integer("retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("sync_history_store_module_idx").on(table.storeId, table.module, table.status),
  ],
);
