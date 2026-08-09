import { eq, sql as drizzleSql } from "@profit/db";
import type { ProfitDb, SQL } from "@profit/db";
import { refreshTokens, sessions, shopifySessions, stores, webhookLogs } from "@profit/db";
import { StoreStatus } from "@profit/types";
import type { AuditService } from "../../audit/audit.service";

/**
 * Webhook business handlers (P2 pipeline: "update database, audit, notify").
 * M1 handlers are intentionally transactional and fast (I5: acknowledge fast);
 * heavier per-topic consumers register with the sync engine in M2.
 *
 * All handlers run on the PLATFORM path (owner connection) and are the sole,
 * audited places where cross-tenant writes happen — install, uninstall and
 * GDPR erasure are platform acts, never merchant-initiated data-plane calls.
 */

export interface WebhookHandlerContext {
  readonly db: ProfitDb;
  readonly audit: AuditService;
  readonly store: { id: string; shopDomain: string };
  readonly payload: Record<string, unknown>;
}

export type WebhookHandler = (ctx: WebhookHandlerContext) => Promise<void>;

/** app/uninstalled — full cleanup (P2/P5: App Uninstall Cleanup). */
export const handleAppUninstalled: WebhookHandler = async ({ db, audit, store }) => {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(stores)
      .set({ status: StoreStatus.Uninstalled, uninstalledAt: now, updatedAt: now })
      .where(eq(stores.id, store.id));

    // Access tokens are dead the moment the merchant uninstalls — delete outright.
    await tx.delete(shopifySessions).where(eq(shopifySessions.storeId, store.id));

    // Close every live merchant session for this store.
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(eq(sessions.storeId, store.id));
    await tx.execute(drizzleSql`
      UPDATE refresh_tokens rt
      SET revoked_at = ${now}
      FROM sessions s
      WHERE rt.session_id = s.id AND s.store_id = ${store.id} AND rt.revoked_at IS NULL
    `);
  });

  await audit.record({
    storeId: store.id,
    action: "shopify.app.uninstalled",
    entityType: "store",
    entityId: store.id,
    result: "SUCCESS",
    metadata: { shopDomain: store.shopDomain },
  });
};

function customerIdsFromPayload(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const customer = payload["customer"];
  if (typeof customer === "object" && customer !== null) {
    const id = (customer as Record<string, unknown>)["id"];
    if (id !== undefined && id !== null) ids.add(String(id));
  }
  const direct = payload["id"];
  if (direct !== undefined && direct !== null) ids.add(String(direct));
  return [...ids];
}

/** customers/redact — scrub all stored payloads containing that customer (GDPR). */
export const handleCustomersRedact: WebhookHandler = async ({ db, audit, store, payload }) => {
  const ids = customerIdsFromPayload(payload);
  if (ids.length > 0) {
    const idParams = drizzleSql.join(
      ids.map((id) => drizzleSql`${id}`),
      drizzleSql`, `,
    );
    const scrub = (column: SQL) => drizzleSql`
      UPDATE webhook_logs
      SET payload = '{"redacted": true}'::jsonb
      WHERE store_id = ${store.id} AND ${column} IN (${idParams})
    `;
    await db.execute(scrub(drizzleSql.raw(`payload->>'id'`)));
    await db.execute(scrub(drizzleSql.raw(`payload->'customer'->>'id'`)));
  }
  await audit.record({
    storeId: store.id,
    action: "gdpr.customers.redact",
    entityType: "store",
    entityId: store.id,
    result: "SUCCESS",
    metadata: { customerIdsScrubbed: ids.length },
  });
};

/** customers/data_request — recorded for the platform's export workflow (GDPR). */
export const handleCustomersDataRequest: WebhookHandler = async ({ audit, store, payload }) => {
  const ids = customerIdsFromPayload(payload);
  const ordersRequested = Array.isArray(payload["orders_requested"])
    ? payload["orders_requested"].length
    : 0;
  await audit.record({
    storeId: store.id,
    action: "gdpr.customers.data_request",
    entityType: "store",
    entityId: store.id,
    result: "SUCCESS",
    metadata: { customerCount: ids.length, ordersRequested },
  });
};

/** shop/redact — purge retained payloads and store contact PII for the shop (GDPR). */
export const handleShopRedact: WebhookHandler = async ({ db, audit, store }) => {
  await db.transaction(async (tx) => {
    await tx
      .update(webhookLogs)
      .set({ payload: { redacted: true } })
      .where(eq(webhookLogs.storeId, store.id));
    await tx
      .update(stores)
      .set({ email: null, updatedAt: new Date() })
      .where(eq(stores.id, store.id));
    // IPs belong to persons, not the shop entity: drop them from live sessions.
    await tx.execute(drizzleSql`
      UPDATE sessions SET ip = NULL
      WHERE store_id = ${store.id}
    `);
    await tx
      .update(sessions)
      .set({ userAgent: null })
      .where(eq(sessions.storeId, store.id));
  });
  await audit.record({
    storeId: store.id,
    action: "gdpr.shop.redact",
    entityType: "store",
    entityId: store.id,
    result: "SUCCESS",
  });
};
