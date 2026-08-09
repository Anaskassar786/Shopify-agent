import type { Logger } from "@profit/logger";
import { shopifyGraphql, ShopifyHttpError, type ShopifyAdminContext } from "@profit/shopify";

/**
 * Webhook subscription reconciliation (P2: "register required webhooks
 * programmatically"). Idempotent by construction: we list current
 * http subscriptions, create only the missing (topic, callbackUrl) pairs and
 * re-point subscriptions whose callback drifted (e.g. APP_URL change).
 * Called after OAuth provisioning and by the durable `shopify.webhooks.ensure`
 * job — drift self-heals instead of accumulating support tickets.
 */

const LIST_QUERY = `
  query WebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      nodes {
        id
        topic
        endpoint {
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
      }
    }
  }
`;

const CREATE_MUTATION = `
  mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

const UPDATE_MUTATION = `
  mutation WebhookSubscriptionUpdate($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

interface SubscriptionNode {
  readonly id: string;
  readonly topic: string;
  readonly endpoint: { readonly callbackUrl?: string } | null;
}

interface ListResponse {
  webhookSubscriptions: { nodes: SubscriptionNode[] };
}

interface MutationResponse<TKey extends string> {
  [key: string]: {
    webhookSubscription: { id: string; topic: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  } | null;
}

/** "products/create" → "PRODUCTS_CREATE" (GraphQL enum vocabulary). */
export function graphqlTopicName(topic: string): string {
  return topic.replace(/\//g, "_").toUpperCase();
}

export interface EnsureResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly existing: readonly string[];
}

export async function ensureWebhookSubscriptions(
  admin: ShopifyAdminContext,
  topics: readonly string[],
  callbackUrl: string,
  logger: Logger,
): Promise<EnsureResult> {
  const listed = await shopifyGraphql<ListResponse>(
    admin.shopDomain,
    admin.apiVersion,
    admin.accessToken,
    LIST_QUERY,
    { first: 250 },
  );

  const created: string[] = [];
  const updated: string[] = [];
  const existing: string[] = [];

  for (const topic of topics) {
    const gqlTopic = graphqlTopicName(topic);
    const current = listed.webhookSubscriptions.nodes.find(
      (node) => node.topic === gqlTopic,
    );
    if (current === undefined) {
      const response = await shopifyGraphql<MutationResponse<"webhookSubscriptionCreate">>(
        admin.shopDomain,
        admin.apiVersion,
        admin.accessToken,
        CREATE_MUTATION,
        {
          topic: gqlTopic,
          webhookSubscription: { callbackUrl, format: "JSON" },
        },
      );
      const payload = response["webhookSubscriptionCreate"];
      if (payload == null || payload.webhookSubscription === null || payload.userErrors.length > 0) {
        throw new ShopifyHttpError(
          200,
          JSON.stringify(payload?.userErrors ?? []),
          `webhookSubscriptionCreate failed for ${topic}`,
        );
      }
      created.push(topic);
      continue;
    }
    if (current.endpoint?.callbackUrl !== callbackUrl) {
      const response = await shopifyGraphql<MutationResponse<"webhookSubscriptionUpdate">>(
        admin.shopDomain,
        admin.apiVersion,
        admin.accessToken,
        UPDATE_MUTATION,
        { id: current.id, webhookSubscription: { callbackUrl, format: "JSON" } },
      );
      const payload = response["webhookSubscriptionUpdate"];
      if (payload == null || payload.webhookSubscription === null || payload.userErrors.length > 0) {
        throw new ShopifyHttpError(
          200,
          JSON.stringify(payload?.userErrors ?? []),
          `webhookSubscriptionUpdate failed for ${topic}`,
        );
      }
      updated.push(topic);
      continue;
    }
    existing.push(topic);
  }

  logger.info(
    { created: created.length, updated: updated.length, existing: existing.length },
    "shopify.webhooks.reconciled",
  );
  return { created, updated, existing };
}
