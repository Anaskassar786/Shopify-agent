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
  CopilotAskResponseDto,
  CopilotConversationDetailDto,
  CopilotConversationListItemDto,
} from "./api-types";

/** Copilot data layer (M8, ADR 32). Threads are server-persisted; asking is
 *  a mutation (writes both messages) — never cached. */

const API = "/api/v1" as const;

export function useCopilotConversationsQuery(): UseQueryResult<readonly CopilotConversationListItemDto[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M8_QK.copilotConversations,
    queryFn: () => client.get<readonly CopilotConversationListItemDto[]>(`${API}/copilot/conversations`),
  });
}

export function useCopilotConversationQuery(
  id: string | null,
): UseQueryResult<CopilotConversationDetailDto, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M8_QK.copilotConversation(id ?? "none"),
    queryFn: () => client.get<CopilotConversationDetailDto>(`${API}/copilot/conversations/${id}`),
    enabled: id !== null,
  });
}

export interface AskCopilotInput {
  readonly question: string;
  readonly conversationId?: string;
}

export function useAskCopilotMutation(): UseMutationResult<CopilotAskResponseDto, ApiError, AskCopilotInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      client.post<CopilotAskResponseDto>(`${API}/copilot/ask`, {
        question: input.question,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: M8_QK.copilotConversations });
      void queryClient.invalidateQueries({ queryKey: M8_QK.copilotConversation(data.conversationId) });
    },
  });
}
