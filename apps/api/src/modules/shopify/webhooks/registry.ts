import { ShopifyWebhookTopic } from "@profit/types";
import {
  handleAppUninstalled,
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
  type WebhookHandler,
} from "./handlers";

/**
 * Topic registry — the single place topics are declared (P2: auto-registration
 * must mirror this table).
 *
 * registration:
 *  - "api":        registered with Shopify via webhookSubscriptionCreate
 *                  (install-time + the durable shopify.webhooks.ensure job)
 *  - "mandatory":  GDPR topics — Shopify delivers these through the mandatory
 *                  webhook configuration; handlers are live from day one (P7)
 *  - "internal":   accepted & logged, consumer activates in a later milestone
 *
 * delivery:
 *  - inline:  handler runs synchronously at intake (platform/compliance acts —
 *             uninstall cleanup & GDPR erasure must never wait on a queue)
 *  - durable: intake persists RECEIVED and a "webhook.process" job carries the
 *             business effect to the worker (at-least-once + retries + DLQ,
 *             without breaching Shopify's ~5s ack budget)
 */

type BusinessTopic =
  | typeof ShopifyWebhookTopic.OrdersCreate
  | typeof ShopifyWebhookTopic.OrdersUpdated
  | typeof ShopifyWebhookTopic.OrdersPaid
  | typeof ShopifyWebhookTopic.OrdersCancelled
  | typeof ShopifyWebhookTopic.ProductsCreate
  | typeof ShopifyWebhookTopic.ProductsUpdate
  | typeof ShopifyWebhookTopic.ProductsDelete
  | typeof ShopifyWebhookTopic.CustomersCreate
  | typeof ShopifyWebhookTopic.CustomersUpdate
  | typeof ShopifyWebhookTopic.CustomersDelete
  | typeof ShopifyWebhookTopic.CollectionsCreate
  | typeof ShopifyWebhookTopic.CollectionsUpdate
  | typeof ShopifyWebhookTopic.CollectionsDelete
  | typeof ShopifyWebhookTopic.DiscountsCreate
  | typeof ShopifyWebhookTopic.DiscountsUpdate
  | typeof ShopifyWebhookTopic.DiscountsDelete
  | typeof ShopifyWebhookTopic.InventoryLevelsUpdate
  | typeof ShopifyWebhookTopic.RefundsCreate;

export interface WebhookRegistryEntry {
  readonly topic: string;
  readonly registration: "api" | "mandatory" | "internal";
  /** Presence marks inline delivery; absence + registration "api" = durable. */
  readonly handler: WebhookHandler | null;
  readonly durable: boolean;
}

const BUSINESS_TOPICS: readonly BusinessTopic[] = [
  ShopifyWebhookTopic.OrdersCreate,
  ShopifyWebhookTopic.OrdersUpdated,
  ShopifyWebhookTopic.OrdersPaid,
  ShopifyWebhookTopic.OrdersCancelled,
  ShopifyWebhookTopic.ProductsCreate,
  ShopifyWebhookTopic.ProductsUpdate,
  ShopifyWebhookTopic.ProductsDelete,
  ShopifyWebhookTopic.CustomersCreate,
  ShopifyWebhookTopic.CustomersUpdate,
  ShopifyWebhookTopic.CustomersDelete,
  ShopifyWebhookTopic.CollectionsCreate,
  ShopifyWebhookTopic.CollectionsUpdate,
  ShopifyWebhookTopic.CollectionsDelete,
  ShopifyWebhookTopic.DiscountsCreate,
  ShopifyWebhookTopic.DiscountsUpdate,
  ShopifyWebhookTopic.DiscountsDelete,
  ShopifyWebhookTopic.InventoryLevelsUpdate,
  ShopifyWebhookTopic.RefundsCreate,
];

export const WEBHOOK_REGISTRY: readonly WebhookRegistryEntry[] = [
  {
    topic: ShopifyWebhookTopic.AppUninstalled,
    registration: "api",
    handler: handleAppUninstalled,
    durable: false,
  },
  {
    topic: ShopifyWebhookTopic.CustomersDataRequest,
    registration: "mandatory",
    handler: handleCustomersDataRequest,
    durable: false,
  },
  {
    topic: ShopifyWebhookTopic.CustomersRedact,
    registration: "mandatory",
    handler: handleCustomersRedact,
    durable: false,
  },
  {
    topic: ShopifyWebhookTopic.ShopRedact,
    registration: "mandatory",
    handler: handleShopRedact,
    durable: false,
  },
  ...BUSINESS_TOPICS.map<WebhookRegistryEntry>((topic) => ({
    topic,
    registration: "api",
    handler: null,
    durable: true,
  })),
];

export interface RegistryLookup {
  readonly entry: WebhookRegistryEntry | null;
  readonly inlineHandler: WebhookHandler | null;
  readonly durable: boolean;
}

export function lookupTopic(topic: string): RegistryLookup {
  const entry = WEBHOOK_REGISTRY.find((candidate) => candidate.topic === topic) ?? null;
  return {
    entry,
    inlineHandler: entry?.handler ?? null,
    durable: entry?.durable ?? false,
  };
}
