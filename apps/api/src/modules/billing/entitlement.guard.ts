import { BillingService } from "@profit/billing";
import type { UsageMeter } from "@profit/types";
import { EntitlementError, ErrorCode } from "../../lib/errors";

/**
 * Shared revenue-action gate (P2 Merchant→…→Subscription). Revenue POSTs call
 * this before touching providers or queues; the thrown EntitlementError is
 * what turns into the web layer's upgrade CTA (403 + structured details).
 * READ paths never use this — browsing history is never paywalled.
 */
export async function assertEntitled(
  billing: BillingService,
  storeId: string,
  meter: UsageMeter,
  additionalUnits = 1,
): Promise<void> {
  const denied = await billing.checkEntitlement(storeId, meter, additionalUnits);
  if (denied === null) return;
  throw new EntitlementError(
    denied.reason === "QUOTA_EXCEEDED" ? ErrorCode.QuotaExceeded : ErrorCode.UpgradeRequired,
    denied.message,
    denied.details,
  );
}
