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
 * must mirror this table; M2 adds its business-topic handlers here).
 *
 * registration:
 *  - "api":        registered with Shopify via webhookSubscriptionCreate at install
 *  - "mandatory":  GDPR topics — Shopify delivers these through the mandatory
 *                  webhook configuration; handlers are live from day one (P7)
 *  - "internal":   accepted & logged, consumer activates in a later milestone
 */

export interface WebhookRegistryEntry {
  readonly topic: string;
  readonly registration: "api" | "mandatory" | "internal";
  readonly handler: WebhookHandler | null;
}

export const WEBHOOK_REGISTRY: readonly WebhookRegistryEntry[] = [
  {
    topic: ShopifyWebhookTopic.AppUninstalled,
    registration: "api",
    handler: handleAppUninstalled,
  },
  {
    topic: ShopifyWebhookTopic.CustomersDataRequest,
    registration: "mandatory",
    handler: handleCustomersDataRequest,
  },
  {
    topic: ShopifyWebhookTopic.CustomersRedact,
    registration: "mandatory",
    handler: handleCustomersRedact,
  },
  {
    topic: ShopifyWebhookTopic.ShopRedact,
    registration: "mandatory",
    handler: handleShopRedact,
  },
];

export function handlerForTopic(topic: string): WebhookHandler | null {
  const entry = WEBHOOK_REGISTRY.find((candidate) => candidate.topic === topic);
  return entry !== undefined ? entry.handler : null;
}
