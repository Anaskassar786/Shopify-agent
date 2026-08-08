import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError, buildQuery } from "../lib/api-client";
import { ADMIN_QK } from "../lib/query-keys";
import type {
  AccessOverrideKindDto,
  AccessOverrideRowDto,
  AccessReviewResponseDto,
  AdminActionRowDto,
  AdminAiUsageRow,
  AdminMerchantRow,
  AdminOverviewResponse,
  AdminSessionResponse,
  AdminTicketReplyResponse,
  AdminTicketRowDto,
  AdminTicketThreadResponse,
  AdminTicketsResponse,
  AdminTrialExtensionResponse,
  OperatorSessionRowDto,
} from "../lib/api-types";
import type { AdminSession } from "../admin/admin-session-store";

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
  enabled = true,
): UseQueryResult<TData, ApiError> {
  return useQuery({
    queryKey: [...queryKey, keyHint] as const,
    enabled,
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

/* ── M6: step-up session + WRITE surface ───────────────────────────────────
 * Reads keep the M5 contract (key in `X-Platform-Admin-Key`). Writes ride
 * the 15-minute HMAC step-up token in `X-Admin-Session`; the server stamps
 * the operator id onto platform_admin_actions — provenance is mandatory.
 */

const ADMIN_SESSION_HEADER = "X-Admin-Session";

export async function openAdminSession(
  key: string,
  operatorId: string,
  reason: string,
): Promise<AdminSessionResponse> {
  let response: Response;
  try {
    response = await fetch(`${API}/session`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", [ADMIN_KEY_HEADER]: key },
      body: JSON.stringify({ operatorId, reason }),
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
    return (parsed as unknown as { data: AdminSessionResponse }).data;
  }
  const errors = (parsed as { errors?: { code: string; message: string }[] } | null)?.errors;
  const first = errors?.[0];
  if (first?.code === "AUTHENTICATION_FAILED") throw new AdminAuthError(first.message);
  throw new ApiError({
    status: response.status,
    code: first?.code ?? "UNEXPECTED_RESPONSE",
    message: first?.message ?? `Unexpected server response (${String(response.status)}).`,
    requestId: null,
    field: null,
    details: null,
  });
}

async function adminPost<TData>(key: string, sessionToken: string, path: string, body?: unknown): Promise<TData> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [ADMIN_KEY_HEADER]: key,
        [ADMIN_SESSION_HEADER]: sessionToken,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  if (first?.code === "AUTHENTICATION_FAILED") throw new AdminAuthError(first.message);
  throw new ApiError({
    status: response.status,
    code: first?.code ?? "UNEXPECTED_RESPONSE",
    message: first?.message ?? `Unexpected server response (${String(response.status)}).`,
    requestId: null,
    field: null,
    details: null,
  });
}

/* ── support inbox (operator side) ───────────────────────────────────────── */

export function useAdminTicketsQuery(
  options: UseAdminQueryOptions,
  page: number,
  attentionOnly: boolean,
  status: string,
): UseQueryResult<AdminTicketsResponse, ApiError> {
  return useAdminQuery<AdminTicketsResponse>(options.adminKey, ADMIN_QK.tickets(page, attentionOnly, status), "/tickets", {
    page,
    pageSize: 25,
    ...(attentionOnly ? { attention: 1 } : {}),
    ...(status !== "" ? { status } : {}),
  });
}

export function useAdminTicketQuery(
  options: UseAdminQueryOptions,
  ticketId: string | null,
): UseQueryResult<AdminTicketThreadResponse, ApiError> {
  return useAdminQuery<AdminTicketThreadResponse>(
    ticketId === null ? null : options.adminKey,
    ADMIN_QK.ticket(ticketId ?? "∅"),
    ticketId === null ? "/tickets" : `/tickets/${ticketId}`,
    undefined,
    ticketId !== null,
  );
}

export function useAdminActionsQuery(
  options: UseAdminQueryOptions,
  page: number,
): UseQueryResult<readonly AdminActionRowDto[], ApiError> {
  return useAdminQuery<readonly AdminActionRowDto[]>(options.adminKey, ADMIN_QK.actions(page), "/actions", {
    page,
    pageSize: 50,
  });
}

export function useAdminOverridesQuery(
  options: UseAdminQueryOptions,
  storeId: string | null,
): UseQueryResult<readonly AccessOverrideRowDto[], ApiError> {
  return useAdminQuery<readonly AccessOverrideRowDto[]>(
    storeId === null ? null : options.adminKey,
    ADMIN_QK.overrides(storeId ?? "∅"),
    storeId === null ? "/merchants" : `/merchants/${storeId}/access-overrides`,
    undefined,
    storeId !== null,
  );
}

/** M7: per-store access review (SOC-2-lite evidence, key-only read). */
export function useAdminAccessReviewQuery(
  options: UseAdminQueryOptions,
  storeId: string | null,
): UseQueryResult<AccessReviewResponseDto, ApiError> {
  return useAdminQuery<AccessReviewResponseDto>(
    storeId === null ? null : options.adminKey,
    ADMIN_QK.review(storeId ?? "∅"),
    "/access-review",
    storeId === null ? undefined : { storeId },
    storeId !== null,
  );
}

/** M7: global operator-session ledger — who held write authority, when, from where. */
export function useAdminOperatorSessionsQuery(
  options: UseAdminQueryOptions,
): UseQueryResult<readonly OperatorSessionRowDto[], ApiError> {
  return useAdminQuery<readonly OperatorSessionRowDto[]>(
    options.adminKey,
    ADMIN_QK.reviewSessions,
    "/access-review/sessions",
  );
}

/* ── writes (all require the step-up session) ────────────────────────────── */

function requireSession(session: AdminSession | null): AdminSession {
  if (session === null) {
    throw new AdminAuthError("Write actions need the step-up session — unlock with operator identity first.");
  }
  return session;
}

export function useAdminTicketReplyMutation(
  adminKey: string,
  session: AdminSession | null,
): UseMutationResult<AdminTicketReplyResponse, ApiError, { ticketId: string; body: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, body }) => adminPost<AdminTicketReplyResponse>(adminKey, requireSession(session).token, `/tickets/${ticketId}/reply`, { body }),
    onSuccess: (_outcome, { ticketId }) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tickets"] });
      void queryClient.invalidateQueries({ queryKey: ADMIN_QK.ticket(ticketId) });
    },
  });
}

export function useAdminTicketTransitionMutation(
  adminKey: string,
  session: AdminSession | null,
): UseMutationResult<AdminTicketRowDto, ApiError, { ticketId: string; verb: "resolve" | "close" }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, verb }) => adminPost<AdminTicketRowDto>(adminKey, requireSession(session).token, `/tickets/${ticketId}/${verb}`),
    onSuccess: (_row, { ticketId }) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tickets"] });
      void queryClient.invalidateQueries({ queryKey: ADMIN_QK.ticket(ticketId) });
      void queryClient.invalidateQueries({ queryKey: ["admin", "actions"] });
    },
  });
}

export interface ExtendTrialInput {
  readonly storeId: string;
  readonly additionalDays: number;
  readonly reason: string;
}

export function useExtendTrialMutation(
  adminKey: string,
  session: AdminSession | null,
): UseMutationResult<AdminTrialExtensionResponse, ApiError, ExtendTrialInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => adminPost<AdminTrialExtensionResponse>(adminKey, requireSession(session).token, `/merchants/${input.storeId}/trial-extension`, input),
    onSuccess: () => {
      // Merchants lists are paged — invalidate the whole prefix so every cached
      // page, the overview tiles and the action log reflect the new truth.
      void queryClient.invalidateQueries({ queryKey: ["admin", "merchants"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "actions"] });
    },
  });
}

export interface GrantOverrideInput {
  readonly storeId: string;
  readonly kind: AccessOverrideKindDto;
  readonly accessUntil: string;
  readonly reason: string;
}

export function useGrantOverrideMutation(
  adminKey: string,
  session: AdminSession | null,
): UseMutationResult<AccessOverrideRowDto, ApiError, GrantOverrideInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => adminPost<AccessOverrideRowDto>(adminKey, requireSession(session).token, `/merchants/${input.storeId}/access-overrides`, input),
    onSuccess: (_row, input) => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_QK.overrides(input.storeId) });
      void queryClient.invalidateQueries({ queryKey: ["admin", "actions"] });
    },
  });
}

export function useRevokeOverrideMutation(
  adminKey: string,
  session: AdminSession | null,
): UseMutationResult<AccessOverrideRowDto, ApiError, { storeId: string; overrideId: string; reason: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ storeId, overrideId, reason }) =>
      adminPost<AccessOverrideRowDto>(adminKey, requireSession(session).token, `/merchants/${storeId}/access-overrides/${overrideId}/revoke`, { reason }),
    onSuccess: (_row, { storeId }) => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_QK.overrides(storeId) });
      void queryClient.invalidateQueries({ queryKey: ["admin", "actions"] });
    },
  });
}
