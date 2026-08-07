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
import type {
  CampaignAudienceDto,
  CampaignRowDto,
  CampaignStatsResponse,
  CampaignTemplateRowDto,
  CampaignVariantDto,
  ExportsResponse,
  MessageChannelDto,
  SuppressionsResponse,
} from "./api-types";

/**
 * Campaign data layer (M6). Mirrors campaigns.router.ts: template CRUD,
 * campaign lifecycle (schedule/cancel/winner), stats and the suppression
 * ledger. All mutations invalidate the list + touched detail.
 */

const API = "/api/v1" as const;

/* ── reads ───────────────────────────────────────────────────────────────── */

export function useCampaignsQuery(): UseQueryResult<readonly CampaignRowDto[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.campaigns,
    queryFn: () => client.get<readonly CampaignRowDto[]>(`${API}/campaigns`),
  });
}

export function useCampaignStatsQuery(
  campaignId: string | null,
): UseQueryResult<CampaignStatsResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.campaignStats(campaignId ?? "∅"),
    enabled: campaignId !== null,
    queryFn: () => client.get<CampaignStatsResponse>(`${API}/campaigns/${campaignId ?? ""}/stats`),
  });
}

export function useCampaignTemplatesQuery(
  channel: MessageChannelDto | "",
): UseQueryResult<readonly CampaignTemplateRowDto[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.campaignTemplates(channel),
    queryFn: () =>
      client.get<readonly CampaignTemplateRowDto[]>(
        `${API}/campaigns/templates`,
        channel === "" ? undefined : { channel },
      ),
  });
}

export function useSuppressionsQuery(
  channel: MessageChannelDto,
  page: number,
): UseQueryResult<SuppressionsResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.suppressions(channel, page),
    queryFn: () =>
      client.get<SuppressionsResponse>(`${API}/campaigns/suppressions/${channel}`, { page, pageSize: 25 }),
  });
}

/* ── template writes ─────────────────────────────────────────────────────── */

export interface TemplateInput {
  readonly name: string;
  readonly channel: MessageChannelDto;
  readonly subject?: string;
  readonly bodyText: string;
  readonly bodyHtml?: string;
}

export function useCreateTemplateMutation(): UseMutationResult<CampaignTemplateRowDto, ApiError, TemplateInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => client.post<CampaignTemplateRowDto>(`${API}/campaigns/templates`, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["campaigns", "templates"] }),
  });
}

export function useUpdateTemplateMutation(): UseMutationResult<
  CampaignTemplateRowDto,
  ApiError,
  { templateId: string } & Partial<TemplateInput>
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, ...body }) =>
      client.put<CampaignTemplateRowDto>(`${API}/campaigns/templates/${templateId}`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["campaigns", "templates"] }),
  });
}

export function useDeleteTemplateMutation(): UseMutationResult<unknown, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId) => client.post<unknown>(`${API}/campaigns/templates/${templateId}/delete`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["campaigns", "templates"] }),
  });
}

/* ── campaign writes ─────────────────────────────────────────────────────── */

export interface VariantInput {
  readonly templateId?: string;
  readonly subject?: string;
  readonly bodyText: string;
  readonly bodyHtml?: string;
}

export interface CreateCampaignInput {
  readonly name: string;
  readonly channel: MessageChannelDto;
  readonly audience: CampaignAudienceDto;
  readonly variantA: VariantInput;
  readonly variantB?: VariantInput;
  readonly splitBPercent?: number;
}

export function useCreateCampaignMutation(): UseMutationResult<CampaignRowDto, ApiError, CreateCampaignInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => client.post<CampaignRowDto>(`${API}/campaigns`, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: M6_QK.campaigns }),
  });
}

export function useScheduleCampaignMutation(): UseMutationResult<
  CampaignRowDto,
  ApiError,
  { campaignId: string; scheduledAt: string | null }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, scheduledAt }) =>
      client.post<CampaignRowDto>(`${API}/campaigns/${campaignId}/schedule`, { scheduledAt }),
    onSuccess: (_row, { campaignId }) => invalidateCampaign(queryClient, campaignId),
  });
}

export function useCancelCampaignMutation(): UseMutationResult<CampaignRowDto, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (campaignId) => client.post<CampaignRowDto>(`${API}/campaigns/${campaignId}/cancel`),
    onSuccess: (_row, campaignId) => invalidateCampaign(queryClient, campaignId),
  });
}

export function useDeclareWinnerMutation(): UseMutationResult<
  CampaignRowDto,
  ApiError,
  { campaignId: string; variant: CampaignVariantDto }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, variant }) =>
      client.post<CampaignRowDto>(`${API}/campaigns/${campaignId}/winner`, { variant }),
    onSuccess: (_row, { campaignId }) => invalidateCampaign(queryClient, campaignId),
  });
}

type Invalidator = ReturnType<typeof useQueryClient>;

function invalidateCampaign(queryClient: Invalidator, campaignId: string): void {
  void queryClient.invalidateQueries({ queryKey: M6_QK.campaigns });
  void queryClient.invalidateQueries({ queryKey: M6_QK.campaign(campaignId) });
  void queryClient.invalidateQueries({ queryKey: M6_QK.campaignStats(campaignId) });
}

/* ── exports live in the campaigns domain? No — separate lib. Kept import type used by pages re-exporting both. */
export type { ExportsResponse };
