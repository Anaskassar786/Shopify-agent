import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { PaginationMeta } from "@profit/types";
import type { NotificationCategory, SyncModule } from "@profit/types";
import { useApiClient } from "./auth-context";
import { ApiError } from "./api-client";
import { QK } from "./query-keys";
import type {
  AnalyticsSummaryResponse,
  AuditLogRow,
  CustomerDetailResponse,
  CustomerRow,
  GlobalSearchResponse,
  InventoryLevelRow,
  NotificationRow,
  OrderDetailResponse,
  OrderRow,
  Paged,
  ProductDetailRow,
  ProductRow,
  StoreResponse,
  SubscriptionResponse,
  SyncHistoryRow,
  SyncStatusResponse,
  SyncTriggerResponse,
  TopCustomerRow,
  TopProductRow,
  VariantRow,
} from "./api-types";

/**
 * Central data access (P2/TanStack). EVERY server interaction lives here:
 * pages stay declarative, wire shapes have exactly one home, and realtime
 * invalidation prefixes (sync / analytics / catalog / notifications) line up
 * with QK by construction.
 */

const API = "/api/v1" as const;

function toPaged<T>(items: readonly T[], meta: PaginationMeta | undefined, page: number): Paged<T> {
  return {
    items,
    page: meta?.page ?? page,
    pageSize: meta?.pageSize ?? items.length,
    totalItems: meta?.totalItems ?? items.length,
  };
}

/* ── Store / billing ─────────────────────────────────────────────────────── */

export function useStoreQuery(): UseQueryResult<StoreResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.store,
    queryFn: () => client.get<StoreResponse>(`${API}/store`),
  });
}

export function useSubscriptionQuery(): UseQueryResult<SubscriptionResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.subscription,
    queryFn: () => client.get<SubscriptionResponse>(`${API}/subscription`),
  });
}

export interface SettingsPatch {
  readonly branding?: { logoUrl?: string; primaryColor?: string };
  readonly aiPreferences?: { autonomyMode?: string; modelTierOverrides?: Record<string, string> };
}

export function usePatchSettingsMutation(): UseMutationResult<unknown, ApiError, SettingsPatch> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => client.patch(`${API}/store/settings`, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QK.store }),
  });
}

export function useCompleteOnboardingMutation(): UseMutationResult<unknown, ApiError, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.post(`${API}/store/onboarding/complete`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QK.store }),
  });
}

export function useStartTrialMutation(): UseMutationResult<unknown, ApiError, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.post(`${API}/subscription/start-trial`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QK.subscription }),
  });
}

/* ── Sync ────────────────────────────────────────────────────────────────── */

export function useSyncStatusQuery(): UseQueryResult<SyncStatusResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.syncStatus,
    queryFn: () => client.get<SyncStatusResponse>(`${API}/sync/status`),
    // Sync moves in seconds; keep the freshest snapshot behind realtime too.
    refetchInterval: 15_000,
  });
}

export function useSyncHistoryQuery(page: number): UseQueryResult<Paged<SyncHistoryRow>, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.syncHistory(page),
    queryFn: async () => {
      const result = await client.getWithMeta<readonly SyncHistoryRow[]>(`${API}/sync/history`, {
        page,
      });
      return toPaged(result.data, result.meta?.pagination, page);
    },
  });
}

export function useTriggerFullSyncMutation(): UseMutationResult<SyncTriggerResponse, ApiError, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.post<SyncTriggerResponse>(`${API}/sync/full`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sync"] }),
  });
}

export function useTriggerModuleSyncMutation(): UseMutationResult<
  SyncTriggerResponse,
  ApiError,
  SyncModule
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (module: SyncModule) =>
      client.post<SyncTriggerResponse>(`${API}/sync/${module.toLowerCase()}`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sync"] }),
  });
}

/* ── Analytics ───────────────────────────────────────────────────────────── */

export function useAnalyticsSummaryQuery(
  days: number,
): UseQueryResult<AnalyticsSummaryResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.analyticsSummary(days),
    queryFn: () => client.get<AnalyticsSummaryResponse>(`${API}/analytics/summary`, { days }),
  });
}

export function useTopProductsQuery(days: number): UseQueryResult<readonly TopProductRow[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.topProducts(days),
    queryFn: () => client.get<readonly TopProductRow[]>(`${API}/analytics/top-products`, { days }),
  });
}

export function useTopCustomersQuery(days: number): UseQueryResult<readonly TopCustomerRow[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.topCustomers(days),
    queryFn: () => client.get<readonly TopCustomerRow[]>(`${API}/analytics/top-customers`, { days }),
  });
}

/* ── Catalog ─────────────────────────────────────────────────────────────── */

export function useProductsQuery(page: number, q: string): UseQueryResult<Paged<ProductRow>, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.products(page, q),
    queryFn: async () => {
      const result = await client.getWithMeta<readonly ProductRow[]>(`${API}/products`, {
        page,
        q: q === "" ? undefined : q,
      });
      return toPaged(result.data, result.meta?.pagination, page);
    },
  });
}

export function useProductQuery(id: string): UseQueryResult<ProductDetailRow, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.product(id),
    queryFn: () => client.get<ProductDetailRow>(`${API}/products/${id}`),
    enabled: id !== "",
  });
}

export function useProductVariantsQuery(id: string): UseQueryResult<readonly VariantRow[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.productVariants(id),
    queryFn: () => client.get<readonly VariantRow[]>(`${API}/products/${id}/variants`),
    enabled: id !== "",
  });
}

export function useCustomersQuery(page: number, q: string): UseQueryResult<Paged<CustomerRow>, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.customers(page, q),
    queryFn: async () => {
      const result = await client.getWithMeta<readonly CustomerRow[]>(`${API}/customers`, {
        page,
        q: q === "" ? undefined : q,
      });
      return toPaged(result.data, result.meta?.pagination, page);
    },
  });
}

export function useCustomerQuery(id: string): UseQueryResult<CustomerDetailResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.customer(id),
    queryFn: () => client.get<CustomerDetailResponse>(`${API}/customers/${id}`),
    enabled: id !== "",
  });
}

export function useOrdersQuery(
  page: number,
  financialStatus: string,
): UseQueryResult<Paged<OrderRow>, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.orders(page, financialStatus),
    queryFn: async () => {
      const result = await client.getWithMeta<readonly OrderRow[]>(`${API}/orders`, {
        page,
        financial_status: financialStatus === "" ? undefined : financialStatus,
      });
      return toPaged(result.data, result.meta?.pagination, page);
    },
  });
}

export function useOrderQuery(id: string): UseQueryResult<OrderDetailResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.order(id),
    queryFn: () => client.get<OrderDetailResponse>(`${API}/orders/${id}`),
    enabled: id !== "",
  });
}

export function useInventoryLevelsQuery(
  page: number,
  below: number | null,
): UseQueryResult<Paged<InventoryLevelRow>, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.inventory(page, below !== null),
    queryFn: async () => {
      const result = await client.getWithMeta<readonly InventoryLevelRow[]>(
        `${API}/inventory/levels`,
        { page, below: below ?? undefined },
      );
      return toPaged(result.data, result.meta?.pagination, page);
    },
  });
}

/* ── Notifications ───────────────────────────────────────────────────────── */

export interface NotificationsPage {
  readonly rows: readonly NotificationRow[];
  readonly unread: number;
  readonly pagination: PaginationMeta;
}

export function useNotificationsQuery(
  page: number,
  unreadOnly: boolean,
  category: NotificationCategory | null,
): UseQueryResult<NotificationsPage, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.notifications(`${String(page)}:${unreadOnly ? "unread" : "all"}:${category ?? "any"}`),
    queryFn: async () => {
      const result = await client.getWithMeta<readonly NotificationRow[]>(`${API}/notifications`, {
        page,
        unreadOnly: unreadOnly ? "true" : "false",
        category: category ?? undefined,
      });
      const unread = result.meta?.extras?.["unread"];
      return {
        rows: result.data,
        unread: typeof unread === "number" ? unread : 0,
        pagination: result.meta?.pagination ?? {
          page,
          pageSize: result.data.length,
          totalItems: result.data.length,
          totalPages: 1,
        },
      };
    },
  });
}

/** Bell badge — cheapest possible call: one row, then read extras.unread. */
export function useUnreadCountQuery(): UseQueryResult<number, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.notifications("badge"),
    queryFn: async () => {
      const result = await client.getWithMeta<readonly NotificationRow[]>(`${API}/notifications`, {
        page: 1,
        limit: 1,
      });
      const unread = result.meta?.extras?.["unread"];
      return typeof unread === "number" ? unread : 0;
    },
    refetchInterval: 30_000,
  });
}

export function useMarkNotificationReadMutation(): UseMutationResult<unknown, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.post(`${API}/notifications/${id}/read`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllNotificationsReadMutation(): UseMutationResult<unknown, ApiError, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.post(`${API}/notifications/read-all`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

/* ── Audit / search ──────────────────────────────────────────────────────── */

export function useAuditLogsQuery(
  page: number,
  action: string,
  result: string,
): UseQueryResult<Paged<AuditLogRow>, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: QK.auditLogs(page, action, result),
    queryFn: async () => {
      const response = await client.getWithMeta<readonly AuditLogRow[]>(`${API}/audit-logs`, {
        page,
        action: action === "" ? undefined : action,
        result: result === "" ? undefined : result,
      });
      return toPaged(response.data, response.meta?.pagination, page);
    },
  });
}

/** Global search fires at 2+ characters (server contract); grouped, per-permission. */
export function useGlobalSearchQuery(q: string): UseQueryResult<GlobalSearchResponse, ApiError> {
  const client = useApiClient();
  const trimmed = q.trim();
  return useQuery({
    queryKey: QK.search(trimmed),
    queryFn: () => client.get<GlobalSearchResponse>(`${API}/search`, { q: trimmed }),
    enabled: trimmed.length >= 2,
    placeholderData: (previous) => previous,
  });
}
