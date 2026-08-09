import { shopifyGraphql } from "@profit/shopify";
import { z } from "zod";
import type { BillingInterval } from "@profit/types";
import type {
  BillingChargeProvider,
  LiveSubscription,
  RecurringChargeRequest,
  RecurringChargeResult,
  SubscriptionStatusUpdate,
} from "./ports";

/**
 * Shopify Admin GraphQL Billing adapter (infrastructure edge — the only file
 * in the platform speaking Shopify's billing vocabulary; wire literals are
 * mapped to domain enums here and never leak outward).
 *
 * Transport is injectable (`graphql` param) following the M4 SmtpTransportFactory
 * / GeminiProvider.fetchImpl pattern: tests stub only the network edge.
 */

type GraphqlTransport = <TData>(
  shopDomain: string,
  apiVersion: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
) => Promise<TData>;

/** Shopify's wire enum mapped at the boundary (never exported). */
const WIRE_INTERVAL: Record<BillingInterval, string> = {
  MONTHLY: "EVERY_30_DAYS",
  YEARLY: "ANNUAL",
};

const userErrorSchema = z.object({
  field: z.array(z.string()).nullish(),
  message: z.string(),
});

const chargeStatusSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
  "ACCEPTED",
  "FROZEN",
]);

const createChargeResponseSchema = z.object({
  appSubscriptionCreate: z.object({
    appSubscription: z.object({ id: z.string().min(1) }).nullable(),
    confirmationUrl: z.string().url().nullable(),
    userErrors: z.array(userErrorSchema),
  }),
});

const cancelChargeResponseSchema = z.object({
  appSubscriptionCancel: z.object({
    appSubscription: z
      .object({ id: z.string().min(1), status: chargeStatusSchema })
      .nullable(),
    userErrors: z.array(userErrorSchema),
  }),
});

const liveSubscriptionsResponseSchema = z.object({
  currentAppInstallation: z.object({
    activeSubscriptions: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        status: chargeStatusSchema,
        test: z.boolean(),
      }),
    ),
  }),
});

export class ShopifyBillingError extends Error {
  readonly userErrors: readonly { message: string }[];
  constructor(action: string, userErrors: readonly { message: string }[]) {
    super(`shopify billing ${action} rejected: ${userErrors.map((e) => e.message).join("; ")}`);
    this.name = "ShopifyBillingError";
    this.userErrors = userErrors;
  }
}

/** "gid://shopify/AppSubscription/123456" → "123456" (ids persisted numeric). */
function chargeIdFromGid(gid: string): string {
  const tail = gid.split("/").pop();
  return tail !== undefined && tail !== "" ? tail : gid;
}

const CREATE_CHARGE_MUTATION = `
  mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $trialDays: Int, $test: Boolean) {
    appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, trialDays: $trialDays, test: $test) {
      appSubscription { id }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

const CANCEL_CHARGE_MUTATION = `
  mutation appSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

const LIVE_SUBSCRIPTIONS_QUERY = `
  query currentAppInstallation {
    currentAppInstallation {
      activeSubscriptions { id name status test }
    }
  }
`;

export class ShopifyBillingProvider implements BillingChargeProvider {
  constructor(
    private readonly shopDomain: string,
    private readonly accessToken: string,
    private readonly apiVersion: string,
    private readonly graphql: GraphqlTransport = shopifyGraphql,
  ) {}

  async createRecurringCharge(request: RecurringChargeRequest): Promise<RecurringChargeResult> {
    const priceInDollars = (request.amountCents / 100).toFixed(2);
    const data = createChargeResponseSchema.parse(
      await this.graphql(this.shopDomain, this.apiVersion, this.accessToken, CREATE_CHARGE_MUTATION, {
        name: request.planName,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: priceInDollars, currencyCode: "USD" },
                interval: WIRE_INTERVAL[request.interval],
              },
            },
          },
        ],
        returnUrl: request.returnUrl,
        trialDays: request.trialDays,
        test: request.test,
      }),
    );
    const result = data.appSubscriptionCreate;
    if (
      result.userErrors.length > 0 ||
      result.appSubscription === null ||
      result.confirmationUrl === null
    ) {
      throw new ShopifyBillingError("appSubscriptionCreate", result.userErrors);
    }
    return {
      chargeId: chargeIdFromGid(result.appSubscription.id),
      confirmationUrl: result.confirmationUrl,
    };
  }

  async cancelRecurringCharge(chargeId: string): Promise<SubscriptionStatusUpdate> {
    const data = cancelChargeResponseSchema.parse(
      await this.graphql(this.shopDomain, this.apiVersion, this.accessToken, CANCEL_CHARGE_MUTATION, {
        id: `gid://shopify/AppSubscription/${chargeId}`,
      }),
    );
    const result = data.appSubscriptionCancel;
    if (result.userErrors.length > 0 || result.appSubscription === null) {
      throw new ShopifyBillingError("appSubscriptionCancel", result.userErrors);
    }
    return { chargeId, status: result.appSubscription.status };
  }

  async fetchLiveSubscriptions(): Promise<readonly LiveSubscription[]> {
    const data = liveSubscriptionsResponseSchema.parse(
      await this.graphql(this.shopDomain, this.apiVersion, this.accessToken, LIVE_SUBSCRIPTIONS_QUERY, {}),
    );
    return data.currentAppInstallation.activeSubscriptions.map((sub) => ({
      chargeId: chargeIdFromGid(sub.id),
      name: sub.name,
      status: sub.status,
      test: sub.test,
    }));
  }
}
