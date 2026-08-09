import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useApiClient } from "./auth-context";
import type { ApiError } from "./api-client";
import { M8_QK } from "./query-keys";
import type {
  ReportDetailDto,
  ReportEmailOutcomeDto,
  ReportGenerateResponseDto,
  ReportKindDto,
  ReportListItemDto,
} from "./api-types";

/** Report vault data layer (M8, ADR 34). Lists poll while anything is
 *  BUILDING so a generated report lands open without a manual refresh. */

const API = "/api/v1" as const;

export function useReportsQuery(kind: ReportKindDto | ""): UseQueryResult<readonly ReportListItemDto[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M8_QK.reports(kind),
    queryFn: () =>
      client.get<readonly ReportListItemDto[]>(`${API}/reports`, kind === "" ? {} : { kind }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((row) => row.status === "BUILDING") ? 3_000 : false,
  });
}

export function useReportDetailQuery(id: string | null): UseQueryResult<ReportDetailDto, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M8_QK.report(id ?? "none"),
    queryFn: () => client.get<ReportDetailDto>(`${API}/reports/${id}`),
    enabled: id !== null,
  });
}

export function useGenerateReportMutation(): UseMutationResult<ReportGenerateResponseDto, ApiError, ReportKindDto> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind) => client.post<ReportGenerateResponseDto>(`${API}/reports/generate`, { kind }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["reports"] }),
  });
}

export interface EmailReportInput {
  readonly id: string;
  readonly recipientEmail?: string;
}

export function useEmailReportMutation(): UseMutationResult<ReportEmailOutcomeDto, ApiError, EmailReportInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      client.post<ReportEmailOutcomeDto>(`${API}/reports/${input.id}/email`, {
        ...(input.recipientEmail !== undefined ? { recipientEmail: input.recipientEmail } : {}),
      }),
    onSuccess: (_data, input) =>
      void queryClient.invalidateQueries({ queryKey: M8_QK.report(input.id) }),
  });
}

export interface DownloadedReport {
  readonly blob: Blob;
  readonly fileName: string;
}

/** Authenticated PDF vault download (bytes + truthful server filename). */
export function useReportDownloadMutation(): UseMutationResult<DownloadedReport, ApiError, string> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (reportId) => {
      const file = await client.download(`${API}/reports/${reportId}/pdf`);
      return { blob: file.blob, fileName: file.fileName ?? `report-${reportId}.pdf` };
    },
  });
}
