import { ApiError } from "./api-client";

/**
 * Entitlement gate UX vocabulary (M5): the API answers revenue-action
 * refusals with exactly these codes — the UI turns them into an upgrade CTA
 * instead of a plain error toast (a denial is a billing conversation, not a
 * crash report).
 */
export const ENTITLEMENT_ERROR_CODES = ["UPGRADE_REQUIRED", "QUOTA_EXCEEDED"] as const;

export function isEntitlementError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (ENTITLEMENT_ERROR_CODES as readonly string[]).includes(error.code)
  );
}
