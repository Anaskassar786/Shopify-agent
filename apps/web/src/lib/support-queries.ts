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
  SupportTicketCategoryDto,
  SupportTicketPriorityDto,
  SupportTicketReplyResponse,
  SupportTicketRowDto,
  SupportTicketThreadResponse,
  SupportTicketsResponse,
} from "./api-types";

/**
 * Support-ticket data layer (M6 merchant side). Mirrors support.router.ts:
 * the merchant opens tickets with a full opening body, the operator thread
 * lives behind the detail query, and reply/close keep the list + thread
 * caches honest on success.
 */

const API = "/api/v1" as const;

export function useSupportTicketsQuery(page: number): UseQueryResult<SupportTicketsResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.supportTickets(page),
    queryFn: () => client.get<SupportTicketsResponse>(`${API}/support/tickets`, { page, pageSize: 20 }),
  });
}

export function useSupportTicketQuery(
  ticketId: string | null,
): UseQueryResult<SupportTicketThreadResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.supportTicket(ticketId ?? "∅"),
    enabled: ticketId !== null,
    queryFn: () => client.get<SupportTicketThreadResponse>(`${API}/support/tickets/${ticketId ?? ""}`),
  });
}

export interface CreateTicketInput {
  readonly subject: string;
  readonly category: SupportTicketCategoryDto;
  readonly priority: SupportTicketPriorityDto;
  readonly body: string;
}

export function useCreateTicketMutation(): UseMutationResult<SupportTicketRowDto, ApiError, CreateTicketInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => client.post<SupportTicketRowDto>(`${API}/support/tickets`, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["support", "tickets"] }),
  });
}

export function useReplyTicketMutation(): UseMutationResult<
  SupportTicketReplyResponse,
  ApiError,
  { ticketId: string; body: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, body }) =>
      client.post<SupportTicketReplyResponse>(`${API}/support/tickets/${ticketId}/reply`, { body }),
    onSuccess: (_outcome, { ticketId }) => {
      void queryClient.invalidateQueries({ queryKey: ["support", "tickets"] });
      void queryClient.invalidateQueries({ queryKey: M6_QK.supportTicket(ticketId) });
    },
  });
}

export function useCloseTicketMutation(): UseMutationResult<SupportTicketRowDto, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId) =>
      client.post<SupportTicketRowDto>(`${API}/support/tickets/${ticketId}/close`),
    onSuccess: (_row, ticketId) => {
      void queryClient.invalidateQueries({ queryKey: ["support", "tickets"] });
      void queryClient.invalidateQueries({ queryKey: M6_QK.supportTicket(ticketId) });
    },
  });
}
