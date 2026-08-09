import type { BillingInterval, PlanCode, SubscriptionStatus } from "@profit/types";

/**
 * BillingChargeProvider — the ONLY way the platform talks to Shopify Billing
 * (I1: business logic never imports a provider SDK; identity of the adapter is
 * invisible to services).
 *
 * Contract guarantees:
 *  - Every returned payload is Zod-validated at the transport edge.
 *  - When the provider is not configured (missing Shopify credentials) the
 *    composition root injects `null` instead — services fail closed with a
 *    typed unavailability, never a simulated charge (permanent rule 1).
 *  - The provider never judges merchant intent: acceptance is established by
 *    reading `currentAppInstallation` from the API after Shopify's redirect,
 *    never from URL parameters.
 */

export interface RecurringChargeRequest {
  readonly planCode: PlanCode;
  readonly planName: string;
  readonly amountCents: number;
  readonly interval: BillingInterval;
  /** Absolute URL Shopify redirects the merchant to after the decision screen. */
  readonly returnUrl: string;
  /** Remaining trial days preserved on the charge (0 when the trial already ended). */
  readonly trialDays: number;
  /** Dev-store charges must be flagged test or the API rejects them. */
  readonly test: boolean;
}

export interface RecurringChargeResult {
  /** Shopify gid is stripped to the numeric charge id by the adapter. */
  readonly chargeId: string;
  /** Merchant-facing decision page — the web layer top-redirects here. */
  readonly confirmationUrl: string;
}

export type ShopifyChargeStatus =
  | "PENDING"
  | "ACTIVE"
  | "DECLINED"
  | "CANCELLED"
  | "EXPIRED"
  | "ACCEPTED"
  | "FROZEN";

export interface LiveSubscription {
  readonly chargeId: string;
  readonly name: string;
  readonly status: ShopifyChargeStatus;
  readonly test: boolean;
}

export interface BillingChargeProvider {
  createRecurringCharge(request: RecurringChargeRequest): Promise<RecurringChargeResult>;
  cancelRecurringCharge(chargeId: string): Promise<SubscriptionStatusUpdate>;
  /** Reads the shop's live subscriptions — the ONLY acceptance source of truth. */
  fetchLiveSubscriptions(): Promise<readonly LiveSubscription[]>;
}

export interface SubscriptionStatusUpdate {
  readonly chargeId: string;
  readonly status: ShopifyChargeStatus;
}

/**
 * TrialMailer — merchant-facing transactional email port used by the trial
 * lifecycle and churn jobs. The composition root binds the SMTP-backed sender
 * when credentials exist; `null` + typed unavailability otherwise (M4 email
 * sender precedent: never a silent no-op).
 */
export interface TransactionalEmail {
  readonly to: string;
  readonly shopName: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

export interface TrialMailer {
  send(email: TransactionalEmail): Promise<void>;
}

/** Narrow store facts the billing services need — no god-objects. */
export interface BillingStoreFacts {
  readonly id: string;
  readonly shopDomain: string;
  readonly name: string;
  readonly email: string | null;
  readonly installedAt: Date;
  /** Resolved OFFLINE access token (decrypted at the composition root). */
  readonly accessToken: string;
}

export type { PlanCode, SubscriptionStatus };
