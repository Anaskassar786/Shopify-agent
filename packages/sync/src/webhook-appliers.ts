import type { ProfitDb } from "@profit/db";
import type { CacheDomain } from "@profit/cache";
import { ShopifyWebhookTopic } from "@profit/types";
import { shopifyGetJson, type ShopifyAdminContext } from "@profit/shopify";
import {
  restCheckoutSchema,
  restCollectionSchema,
  restCustomerSchema,
  restInventoryLevelSchema,
  restOrderSchema,
  restPriceRuleSchema,
  restProductSchema,
} from "./dto";
import {
  deleteCollectionByShopifyId,
  deleteCustomerByShopifyId,
  deletePriceRuleByShopifyId,
  deleteProductByShopifyId,
  upsertCheckouts,
  upsertCollections,
  upsertCustomers,
  upsertInventoryLevels,
  upsertOrders,
  upsertPriceRules,
  upsertProducts,
} from "./writers";
import { CollectionType } from "@profit/types";

/**
 * Business-webhook appliers (P2 webhook pipeline → data plane). These run on
 * the worker via the durable "webhook.process" job — the intake path (API)
 * stays HMAC-verify → persist → ack in milliseconds, exactly as Shopify's
 * delivery contract demands.
 *
 * Every applier returns the same side-effect descriptor so the worker handler
 * performs cache invalidation + targeted analytics refresh uniformly. Delete
 * topics carry minimal payloads ({ id }); delete is authoritative, not a
 * status flip — cascades keep referential integrity.
 */

export interface WebhookApplyContext {
  readonly db: ProfitDb;
  readonly storeId: string;
  readonly shopDomain: string;
  readonly payload: Record<string, unknown>;
  /** Offline-token admin context — only appliers that must re-fetch use it. */
  readonly admin: ShopifyAdminContext;
}

export interface WebhookApplyResult {
  /** Cache domains to version-bump for this store. */
  readonly invalidate: readonly CacheDomain[];
  /** UTC dates (YYYY-MM-DD) whose metric rows need recomputation. */
  readonly analyticsDates: readonly string[];
}

type WebhookApplier = (ctx: WebhookApplyContext) => Promise<WebhookApplyResult>;

const NONE: WebhookApplyResult = { invalidate: [], analyticsDates: [] };

function shopifyIdOf(payload: Record<string, unknown>): string | null {
  const id = payload["id"];
  if (typeof id === "number" || typeof id === "string") return String(id);
  return null;
}

const applyOrderPayload: WebhookApplier = async (ctx) => {
  const order = restOrderSchema.parse(ctx.payload);
  const { analyticDates } = await upsertOrders(ctx.db, ctx.storeId, [order]);
  return { invalidate: ["analytics", "catalog"], analyticsDates: [...analyticDates] };
};

const applyOrderDelete: WebhookApplier = async (ctx) => {
  // orders/delete ships the full payload of the cancelled/deleted order;
  // we keep the replica consistent by upserting (cancelled_at present).
  return applyOrderPayload(ctx);
};

const applyProduct: WebhookApplier = async (ctx) => {
  const product = restProductSchema.parse(ctx.payload);
  await upsertProducts(ctx.db, ctx.storeId, [product]);
  return { invalidate: ["catalog"], analyticsDates: [] };
};

const applyProductDelete: WebhookApplier = async (ctx) => {
  const id = shopifyIdOf(ctx.payload);
  if (id !== null) await deleteProductByShopifyId(ctx.db, ctx.storeId, id);
  return { invalidate: ["catalog"], analyticsDates: [] };
};

const applyCustomer: WebhookApplier = async (ctx) => {
  const customer = restCustomerSchema.parse(ctx.payload);
  await upsertCustomers(ctx.db, ctx.storeId, [customer]);
  return { invalidate: ["analytics"], analyticsDates: [] };
};

const applyCustomerDelete: WebhookApplier = async (ctx) => {
  const id = shopifyIdOf(ctx.payload);
  if (id !== null) await deleteCustomerByShopifyId(ctx.db, ctx.storeId, id);
  return { invalidate: ["analytics"], analyticsDates: [] };
};

const applyInventoryLevel: WebhookApplier = async (ctx) => {
  const level = restInventoryLevelSchema.parse(ctx.payload);
  await upsertInventoryLevels(ctx.db, ctx.storeId, [level]);
  return { invalidate: ["catalog"], analyticsDates: [] };
};

const applyCollection: WebhookApplier = async (ctx) => {
  const parsed = restCollectionSchema.passthrough().parse(ctx.payload);
  // Webhook payload carries no discriminator; `rules` marks smart collections.
  const collectionType = Array.isArray((ctx.payload as Record<string, unknown>)["rules"])
    ? CollectionType.Smart
    : CollectionType.Custom;
  await upsertCollections(ctx.db, ctx.storeId, [parsed], collectionType);
  return { invalidate: ["catalog"], analyticsDates: [] };
};

const applyCollectionDelete: WebhookApplier = async (ctx) => {
  const id = shopifyIdOf(ctx.payload);
  if (id !== null) await deleteCollectionByShopifyId(ctx.db, ctx.storeId, id);
  return { invalidate: ["catalog"], analyticsDates: [] };
};

const applyDiscount: WebhookApplier = async (ctx) => {
  const rule = restPriceRuleSchema.parse(ctx.payload);
  await upsertPriceRules(ctx.db, ctx.storeId, [rule]);
  return { invalidate: ["catalog"], analyticsDates: [] };
};

const applyDiscountDelete: WebhookApplier = async (ctx) => {
  const id = shopifyIdOf(ctx.payload);
  if (id !== null) await deletePriceRuleByShopifyId(ctx.db, ctx.storeId, id);
  return { invalidate: ["catalog"], analyticsDates: [] };
};

/**
 * refunds/create carries only the refund delta; re-fetching the order yields
 * the authoritative refunds array so total_refunded is set-based (replay-safe)
 * rather than incremental arithmetic.
 */
const applyRefund: WebhookApplier = async (ctx) => {
  const orderIdRaw = ctx.payload["order_id"];
  if (typeof orderIdRaw !== "number" && typeof orderIdRaw !== "string") return NONE;
  const orderId = String(orderIdRaw);
  const result = await shopifyGetJson<{ order: unknown }>(
    `https://${ctx.admin.shopDomain}/admin/api/${ctx.admin.apiVersion}/orders/${orderId}.json`,
    { "X-Shopify-Access-Token": ctx.admin.accessToken },
  );
  const order = restOrderSchema.parse(result.data.order);
  const { analyticDates } = await upsertOrders(ctx.db, ctx.storeId, [order]);
  const refundDates = new Set<string>(analyticDates);
  const processedAt = order.processed_at;
  if (processedAt !== null && processedAt !== undefined) {
    refundDates.add(processedAt.toISOString().slice(0, 10));
  }
  return { invalidate: ["analytics"], analyticsDates: [...refundDates] };
};

/** M4: checkouts feed the abandoned-cart engine — upsert-only (no deletes topic). */
const applyCheckout: WebhookApplier = async (ctx) => {
  const checkout = restCheckoutSchema.parse(ctx.payload);
  await upsertCheckouts(ctx.db, ctx.storeId, [checkout]);
  // No cache domain renders raw checkouts in v1; analytics spans derive from orders.
  return { invalidate: [], analyticsDates: [] };
};

export const WEBHOOK_APPLIERS: Readonly<Record<string, WebhookApplier>> = {
  [ShopifyWebhookTopic.OrdersCreate]: applyOrderPayload,
  [ShopifyWebhookTopic.OrdersUpdated]: applyOrderPayload,
  [ShopifyWebhookTopic.OrdersPaid]: applyOrderPayload,
  [ShopifyWebhookTopic.OrdersCancelled]: applyOrderDelete,
  [ShopifyWebhookTopic.ProductsCreate]: applyProduct,
  [ShopifyWebhookTopic.ProductsUpdate]: applyProduct,
  [ShopifyWebhookTopic.ProductsDelete]: applyProductDelete,
  [ShopifyWebhookTopic.CustomersCreate]: applyCustomer,
  [ShopifyWebhookTopic.CustomersUpdate]: applyCustomer,
  [ShopifyWebhookTopic.CustomersDelete]: applyCustomerDelete,
  [ShopifyWebhookTopic.CollectionsCreate]: applyCollection,
  [ShopifyWebhookTopic.CollectionsUpdate]: applyCollection,
  [ShopifyWebhookTopic.CollectionsDelete]: applyCollectionDelete,
  [ShopifyWebhookTopic.DiscountsCreate]: applyDiscount,
  [ShopifyWebhookTopic.DiscountsUpdate]: applyDiscount,
  [ShopifyWebhookTopic.DiscountsDelete]: applyDiscountDelete,
  [ShopifyWebhookTopic.InventoryLevelsUpdate]: applyInventoryLevel,
  [ShopifyWebhookTopic.RefundsCreate]: applyRefund,
  [ShopifyWebhookTopic.CheckoutsCreate]: applyCheckout,
  [ShopifyWebhookTopic.CheckoutsUpdate]: applyCheckout,
};

export function applierForTopic(topic: string): WebhookApplier | null {
  return WEBHOOK_APPLIERS[topic] ?? null;
}

/**
 * Business topics the app registers with Shopify (subscription reconciliation
 * in webhook-registrar.ts creates/updates exactly these + APP_UNINSTALLED).
 * GDPR topics ride the mandatory-webhook channel and never appear here.
 */
export const REGISTERED_BUSINESS_TOPICS: readonly string[] = Object.keys(WEBHOOK_APPLIERS);
