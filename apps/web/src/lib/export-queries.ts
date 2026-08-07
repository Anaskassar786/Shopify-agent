import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useApiClient } from "./auth-context";
import { ApiError } from "./api-client";
import { M6_QK } from "./query-keys";
import type { ExportFormatDto, ExportKindDto, ExportRowDto, ExportsResponse } from "./api-types";

/**
 * Export data layer (M6). The list self-polls while anything is QUEUED or
 * RUNNING so a merchant never needs to hit refresh to see a READY file;
 * downloads flow through the authenticated ApiClient (same refresh contract)
 * and are handed to the caller as bytes + a truthful server file name.
 */

const API = "/api/v1" as const;

export function useExportsQuery(page: number): UseQueryResult<ExportsResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.exports(page),
    queryFn: () => client.get<ExportsResponse>(`${API}/exports`, { page, pageSize: 25 }),
    // Poll only while work is in flight — steady state stays quiet.
    refetchInterval: (query) =>
      (query.state.data?.rows ?? []).some((row) => row.status === "QUEUED" || row.status === "RUNNING")
        ? 3_000
        : false,
  });
}

export interface RequestExportInput {
  readonly kind: ExportKindDto;
  readonly format: ExportFormatDto;
  readonly from?: string;
  readonly to?: string;
}

export function useRequestExportMutation(): UseMutationResult<ExportRowDto, ApiError, RequestExportInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => {
      const params: Record<string, string> = {};
      if (input.from !== undefined) params["from"] = input.from;
      if (input.to !== undefined) params["to"] = input.to;
      const body: Record<string, unknown> = { kind: input.kind, format: input.format };
      if (Object.keys(params).length > 0) body["params"] = params;
      return client.post<ExportRowDto>(`${API}/exports`, body);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["exports"] }),
  });
}

export interface DownloadedExport {
  readonly blob: Blob;
  readonly fileName: string;
}

/** Authenticated binary fetch of a READY export; throws ApiError (409 until READY). */
export function useExportDownloadMutation(): UseMutationResult<DownloadedExport, ApiError, ExportRowDto> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (row) => {
      const file = await client.download(`${API}/exports/${row.id}/download`);
      return { blob: file.blob, fileName: file.fileName ?? row.fileName ?? `export-${row.id}` };
    },
  });
}

/** One-click AUDIT_LOGS CSV export used by the audit page header action. */
export function useAuditExportRequest(
  onFeedback: (kind: "success" | "error", title: string, body?: string) => void,
): { request: () => void; pending: boolean } {
  const mutation = useRequestExportMutation();
  return {
    pending: mutation.isPending,
    request: () =>
      mutation.mutate(
        { kind: "AUDIT_LOGS", format: "CSV" },
        {
          onSuccess: () => onFeedback("success", "Audit export queued", "Watch Exports — it will appear there in a moment."),
          onError: (error) => onFeedback("error", "Export could not be queued", error.message),
        },
      ),
  };
}
