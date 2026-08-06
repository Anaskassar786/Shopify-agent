import { describe, expect, it } from "vitest";
import { BillingInterval, PlanCode } from "@profit/types";
import { ShopifyBillingError, ShopifyBillingProvider } from "./shopify-billing.provider";
import type { RecurringChargeRequest } from "./ports";

/**
 * Adapter contract tests: the GraphQL transport is the ONLY stubbed edge
 * (house pattern — M4 GeminiProvider.fetchImpl / SmtpTransportFactory).
 */

type GraphqlCall = { query: string; variables: Record<string, unknown> };

function providerReturning(payload: unknown, calls: GraphqlCall[]): ShopifyBillingProvider {
  return new ShopifyBillingProvider(
    "demo-store.myshopify.com",
    "shpat_fixture",
    "2025-10",
    <TData>(
      shopDomain: string,
      apiVersion: string,
      accessToken: string,
      query: string,
      variables: Record<string, unknown>,
    ): Promise<TData> => {
      expect(shopDomain).toBe("demo-store.myshopify.com");
      expect(apiVersion).toBe("2025-10");
      expect(accessToken).toBe("shpat_fixture");
      calls.push({ query, variables });
      // The fixture payload stands in for the wire; the provider's zod schemas
      // re-validate it on every call (that re-validation IS the contract).
      return Promise.resolve(payload as TData);
    },
  );
}

const chargeRequest: RecurringChargeRequest = {
  planCode: PlanCode.Growth,
  planName: "PROFIT TOOL AI — Growth (monthly)",
  amountCents: 7900,
  interval: BillingInterval.Monthly,
  returnUrl: "https://app.profit.test/api/v1/billing/callback",
  trialDays: 3,
  test: true,
};

describe("createRecurringCharge", () => {
  it("maps domain → wire (interval, dollars, gid stripping) and validates the response", async () => {
    const calls: GraphqlCall[] = [];
    const provider = providerReturning(
      {
        appSubscriptionCreate: {
          appSubscription: { id: "gid://shopify/AppSubscription/33829174" },
          confirmationUrl: "https://demo-store.myshopify.com/admin/charges/33829174/confirm",
          userErrors: [],
        },
      },
      calls,
    );
    const result = await provider.createRecurringCharge(chargeRequest);
    expect(result).toEqual({
      chargeId: "33829174",
      confirmationUrl: "https://demo-store.myshopify.com/admin/charges/33829174/confirm",
    });
    const variables = calls[0]!.variables;
    expect(variables["returnUrl"]).toBe(chargeRequest.returnUrl);
    expect(variables["trialDays"]).toBe(3);
    expect(variables["test"]).toBe(true);
    const lineItems = variables["lineItems"] as {
      plan: { appRecurringPricingDetails: { price: { amount: string; currencyCode: string }; interval: string } };
    }[];
    expect(lineItems[0]!.plan.appRecurringPricingDetails.price).toEqual({
      amount: "79.00",
      currencyCode: "USD",
    });
    expect(lineItems[0]!.plan.appRecurringPricingDetails.interval).toBe("EVERY_30_DAYS");
  });

  it("sends ANNUAL for yearly charges", async () => {
    const calls: GraphqlCall[] = [];
    const provider = providerReturning(
      {
        appSubscriptionCreate: {
          appSubscription: { id: "gid://shopify/AppSubscription/1" },
          confirmationUrl: "https://x.myshopify.com/confirm",
          userErrors: [],
        },
      },
      calls,
    );
    await provider.createRecurringCharge({ ...chargeRequest, interval: BillingInterval.Yearly });
    const lineItems = calls[0]!.variables["lineItems"] as {
      plan: { appRecurringPricingDetails: { interval: string } };
    }[];
    expect(lineItems[0]!.plan.appRecurringPricingDetails.interval).toBe("ANNUAL");
  });

  it("surfaces Shopify userErrors as a typed billing error", async () => {
    const provider = providerReturning(
      {
        appSubscriptionCreate: {
          appSubscription: null,
          confirmationUrl: null,
          userErrors: [{ field: ["plan"], message: "Recurring application charge is not valid" }],
        },
      },
      [],
    );
    await expect(provider.createRecurringCharge(chargeRequest)).rejects.toThrow(ShopifyBillingError);
    await expect(provider.createRecurringCharge(chargeRequest)).rejects.toMatchObject({
      name: "ShopifyBillingError",
      userErrors: [{ field: ["plan"], message: "Recurring application charge is not valid" }],
    });
  });

  it("rejects malformed responses at the boundary (zod)", async () => {
    const provider = providerReturning({ appSubscriptionCreate: { unexpected: true } }, []);
    await expect(provider.createRecurringCharge(chargeRequest)).rejects.toThrow();
  });
});

describe("cancelRecurringCharge", () => {
  it("rebuilds the gid and returns the wire status", async () => {
    const calls: GraphqlCall[] = [];
    const provider = providerReturning(
      {
        appSubscriptionCancel: {
          appSubscription: { id: "gid://shopify/AppSubscription/777", status: "CANCELLED" },
          userErrors: [],
        },
      },
      calls,
    );
    const result = await provider.cancelRecurringCharge("777");
    expect(result).toEqual({ chargeId: "777", status: "CANCELLED" });
    expect(calls[0]!.variables["id"]).toBe("gid://shopify/AppSubscription/777");
  });

  it("throws on userErrors", async () => {
    const provider = providerReturning(
      {
        appSubscriptionCancel: {
          appSubscription: null,
          userErrors: [{ field: null, message: "Charge not found" }],
        },
      },
      [],
    );
    await expect(provider.cancelRecurringCharge("777")).rejects.toThrow(ShopifyBillingError);
  });
});

describe("fetchLiveSubscriptions", () => {
  it("maps every live subscription to the domain shape", async () => {
    const provider = providerReturning(
      {
        currentAppInstallation: {
          activeSubscriptions: [
            { id: "gid://shopify/AppSubscription/10", name: "Growth (monthly)", status: "ACTIVE", test: true },
            { id: "gid://shopify/AppSubscription/11", name: "Old", status: "CANCELLED", test: false },
          ],
        },
      },
      [],
    );
    const live = await provider.fetchLiveSubscriptions();
    expect(live).toEqual([
      { chargeId: "10", name: "Growth (monthly)", status: "ACTIVE", test: true },
      { chargeId: "11", name: "Old", status: "CANCELLED", test: false },
    ]);
  });

  it("rejects unexpected charge statuses at the boundary", async () => {
    const provider = providerReturning(
      {
        currentAppInstallation: {
          activeSubscriptions: [{ id: "gid://shopify/AppSubscription/10", name: "x", status: "MYSTERY", test: false }],
        },
      },
      [],
    );
    await expect(provider.fetchLiveSubscriptions()).rejects.toThrow();
  });
});
