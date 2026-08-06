import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "../lib/api-client";
import { useApiClient } from "../lib/auth-context";
import { BILLING_QK } from "../lib/query-keys";
import type {
  BillingEventRow,
  BillingIntervalValue,
  BillingOverviewResponse,
  PlansCatalogResponse,
  RoiReportResponse,
  SubscribeStartedResponse,
} from "../lib/api-types";

/**
 * M5 billing/growth-plane hooks. Same envelope discipline as ../queries.ts —
 * one home per endpoint so components never drift on paths or keys. ROI rides
 * under the billing root (its render surface is the Billing page value block).
 */

const API = "/api/v1";

export function useBillingOverviewQuery(): UseQueryResult<BillingOverviewResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: BILLING_QK.overview,
    queryFn: () => client.get<BillingOverviewResponse>(`${API}/billing/overview`),
  });
}

export function useBillingPlansQuery(): UseQueryResult<PlansCatalogResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: BILLING_QK.plans,
    queryFn: () => client.get<PlansCatalogResponse>(`${API}/billing/plans`),
    // The catalog changes with releases, not sessions — safe to keep warm.
    staleTime: 5 * 60_000,
  });
}

export function useBillingHistoryQuery(): UseQueryResult<readonly BillingEventRow[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: BILLING_QK.history,
    queryFn: () => client.get<readonly BillingEventRow[]>(`${API}/billing/history`),
  });
}

export function useRoiReportQuery(windowDays: 30 | 90): UseQueryResult<RoiReportResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: BILLING_QK.roi(windowDays),
    queryFn: () => client.get<RoiReportResponse>(`${API}/analytics/roi`, { windowDays }),
  });
}

export interface SubscribeInput {
  readonly planCode: string;
  readonly interval: BillingIntervalValue;
}

/**
 * Begin the Shopify recurring-charge flow. The 201 carries Shopify's decision
 * screen URL — the page performs the mandatory TOP-LEVEL redirect (Shopify
 * refuses to render the charge screen inside an iframe).
 */
export function useSubscribeMutation(): UseMutationResult<SubscribeStartedResponse, ApiError, SubscribeInput> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (input: SubscribeInput) =>
      client.post<SubscribeStartedResponse>(`${API}/billing/subscribe`, input),
  });
}

export function useCancelSubscriptionMutation(): UseMutationResult<unknown, ApiError, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.post(`${API}/billing/cancel`, {}),
    onSuccess: () => invalidateBillingQueries(queryClient),
  });
}

/** Shopify truth can arrive via callback/reconcile between renders — invalidate broadly. */
function invalidateBillingQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["billing"] });
  void queryClient.invalidateQueries({ queryKey: ["subscription"] });
  void queryClient.invalidateQueries({ queryKey: ["store"] });
}

/* ── Client-visible engagement telemetry (M5 funnel) ───────────────────────── */

export type ClientEngagementKind = "FIRST_AI_INSIGHT_VIEWED" | "UPGRADE_VIEWED";

export interface EngagementEmitInput {
  readonly kind: ClientEngagementKind;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget funnel event (server dedupes milestones per store). Never
 * throws into the UI: a telemetry failure is invisible to merchants — the
 * mutation result is swallowed at call sites.
 */
export function useEmitEngagementEventMutation(): UseMutationResult<
  { readonly recorded: boolean },
  ApiError,
  EngagementEmitInput
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (input: EngagementEmitInput) =>
      client.post<{ readonly recorded: boolean }>(`${API}/engagement/events`, input),
  });
}
