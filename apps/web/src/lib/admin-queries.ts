import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError, buildQuery } from "../lib/api-client";
import { ADMIN_QK } from "../lib/query-keys";
import type {
  AdminAiUsageRow,
  AdminMerchantRow,
  AdminOverviewResponse,
} from "../lib/api-types";

/**
 * Platform-admin data layer (M5 Super Admin v1). Deliberately NOT the session
 * ApiClient: the admin surface authenticates with X-Platform-Admin-Key and
 * stands OUTSIDE the Shopify embedded app (separate React tree, separate
 * trust boundary). The key lives in memory only — typing it again after a
 * reload is a feature, not a bug.
 *
 * Wire parity is enforced by api-types.ts (AdminOverviewResponse etc. mirror
 * GrowthAnalyticsService output exactly).
 */

const API = "/api/v1/admin";
const ADMIN_KEY_HEADER = "X-Platform-Admin-Key";

/** The middleware rejects missing/wrong keys with exactly this 401 envelope code. */
export class AdminAuthError extends ApiError {
  readonly locked: boolean;
  constructor(message: string) {
    super({ status: 401, code: "AUTHENTICATION_FAILED", message, requestId: null, field: null, details: null });
    this.name = "AdminAuthError";
    this.locked = true;
  }
}

async function adminGet<TData>(key: string, path: string, params?: Record<string, string | number | undefined>): Promise<TData> {
  const query = params !== undefined ? buildQuery(params) : "";
  let response: Response;
  try {
    response = await fetch(`${API}${path}${query}`, {
      headers: { Accept: "application/json", [ADMIN_KEY_HEADER]: key },
    });
  } catch {
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "The server could not be reached. Check your connection and retry.",
      requestId: null,
      field: null,
      details: null,
    });
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "success" in parsed &&
    (parsed as { success: unknown }).success === true &&
    "data" in parsed
  ) {
    return (parsed as unknown as { data: TData }).data;
  }
  const errors = (parsed as { errors?: { code: string; message: string }[] } | null)?.errors;
  const first = errors?.[0];
  if (first?.code === "AUTHENTICATION_FAILED") {
    throw new AdminAuthError(first.message);
  }
  throw new ApiError({
    status: response.status,
    code: first?.code ?? "UNEXPECTED_RESPONSE",
    message: first?.message ?? `Unexpected server response (${String(response.status)}).`,
    requestId: null,
    field: null,
    details: null,
  });
}

/** Check the middleware + platform-admin middleware emit exactly these codes. */
export function isAdminAuthError(error: unknown): error is AdminAuthError {
  return error instanceof AdminAuthError;
}

function useAdminQuery<TData>(
  keyHint: string | null,
  queryKey: readonly unknown[],
  path: string,
  params?: Record<string, string | number | undefined>,
): UseQueryResult<TData, ApiError> {
  return useQuery({
    queryKey: [...queryKey, keyHint] as const,
    queryFn: () => {
      if (keyHint === null) {
        return Promise.reject(new AdminAuthError("Enter the platform admin key to continue."));
      }
      return adminGet<TData>(keyHint, path, params);
    },
    // No key → no request; wrong key → surfaced as admin auth error, no retry loop.
    retry: (failureCount, error) => !(error instanceof AdminAuthError) && failureCount < 1,
  });
}

export interface UseAdminQueryOptions {
  /** The in-memory operator key — null until the key gate is satisfied. */
  readonly adminKey: string | null;
}

export function useAdminOverviewQuery(
  options: UseAdminQueryOptions,
): UseQueryResult<AdminOverviewResponse, ApiError> {
  return useAdminQuery<AdminOverviewResponse>(options.adminKey, ADMIN_QK.overview, "/overview");
}

export function useAdminMerchantsQuery(
  options: UseAdminQueryOptions,
  page: number,
): UseQueryResult<readonly AdminMerchantRow[], ApiError> {
  return useAdminQuery<readonly AdminMerchantRow[]>(options.adminKey, ADMIN_QK.merchants(page), "/merchants", {
    page,
    pageSize: 25,
  });
}

export function useAdminAiUsageQuery(
  options: UseAdminQueryOptions,
): UseQueryResult<readonly AdminAiUsageRow[], ApiError> {
  return useAdminQuery<readonly AdminAiUsageRow[]>(options.adminKey, ADMIN_QK.aiUsage, "/ai-usage");
}

/** Refresh everything admin-visible (manual refresh button on the panel). */
export function useAdminRefresh(): () => void {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ["admin"] });
}
