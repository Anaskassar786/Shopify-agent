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
  WorkflowCreateResponse,
  WorkflowDefinitionDto,
  WorkflowDetailResponse,
  WorkflowRowDto,
  WorkflowRunDetailResponse,
  WorkflowRunsResponse,
} from "./api-types";

/**
 * Workflow data layer (M6 Automation Center). Mirrors workflows.router.ts
 * one-to-one; every mutation invalidates the list + the touched detail so
 * canvas state and lifecycle badges can never drift from the server truth.
 */

const API = "/api/v1" as const;

export function useWorkflowsQuery(): UseQueryResult<readonly WorkflowRowDto[], ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.workflows,
    queryFn: () => client.get<readonly WorkflowRowDto[]>(`${API}/workflows`),
  });
}

export function useWorkflowQuery(
  workflowId: string | null,
): UseQueryResult<WorkflowDetailResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.workflow(workflowId ?? "∅"),
    enabled: workflowId !== null,
    queryFn: () => client.get<WorkflowDetailResponse>(`${API}/workflows/${workflowId ?? ""}`),
  });
}

export function useWorkflowRunsQuery(
  workflowId: string | null,
  page: number,
): UseQueryResult<WorkflowRunsResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.workflowRuns(workflowId ?? "∅", page),
    enabled: workflowId !== null,
    queryFn: () =>
      client.get<WorkflowRunsResponse>(`${API}/workflows/${workflowId ?? ""}/runs`, { page, pageSize: 10 }),
    // Live runs move on their own — poll while any are in motion, else stay quiet.
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((run) => run.status === "RUNNING" || run.status === "WAITING")
        ? 3_000
        : false,
  });
}

export function useWorkflowRunStepsQuery(
  workflowId: string | null,
  runId: string | null,
): UseQueryResult<WorkflowRunDetailResponse, ApiError> {
  const client = useApiClient();
  return useQuery({
    queryKey: M6_QK.runSteps(workflowId ?? "∅", runId ?? "∅"),
    enabled: workflowId !== null && runId !== null,
    queryFn: () =>
      client.get<WorkflowRunDetailResponse>(`${API}/workflows/${workflowId ?? ""}/runs/${runId ?? ""}/steps`),
  });
}

export interface CreateWorkflowInput {
  readonly name: string;
  readonly description?: string;
  readonly definition: WorkflowDefinitionDto;
}

export function useCreateWorkflowMutation(): UseMutationResult<WorkflowCreateResponse, ApiError, CreateWorkflowInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => client.post<WorkflowCreateResponse>(`${API}/workflows`, input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: M6_QK.workflows });
      queryClient.setQueryData(M6_QK.workflow(created.workflow.id), {
        workflow: created.workflow,
        versions: [created.version],
        activeDefinition: null,
      } satisfies WorkflowDetailResponse);
    },
  });
}

export interface SaveWorkflowInput {
  readonly workflowId: string;
  readonly name?: string;
  readonly description?: string;
  readonly definition?: WorkflowDefinitionDto;
}

/** PUT bumps an immutable version whenever a definition rides along (server rule). */
export function useSaveWorkflowMutation(): UseMutationResult<WorkflowCreateResponse, ApiError, SaveWorkflowInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => {
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body["name"] = input.name;
      if (input.description !== undefined) body["description"] = input.description;
      if (input.definition !== undefined) body["definition"] = input.definition;
      return client.put<WorkflowCreateResponse>(`${API}/workflows/${input.workflowId}`, body);
    },
    onSuccess: (_saved, input) => {
      void queryClient.invalidateQueries({ queryKey: M6_QK.workflows });
      void queryClient.invalidateQueries({ queryKey: M6_QK.workflow(input.workflowId) });
      void queryClient.invalidateQueries({ queryKey: ["workflows", input.workflowId, "runs"] });
    },
  });
}

export type WorkflowLifecycleAction = "activate" | "pause" | "archive" | "run";

export function useWorkflowActionMutation(): UseMutationResult<unknown, ApiError, { workflowId: string; readonly action: WorkflowLifecycleAction }> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    // All four lifecycle verbs are body-less POSTs by router contract.
    mutationFn: ({ workflowId, action }) => client.post<unknown>(`${API}/workflows/${workflowId}/${action}`),
    onSuccess: (_result, { workflowId }) => {
      void queryClient.invalidateQueries({ queryKey: M6_QK.workflows });
      void queryClient.invalidateQueries({ queryKey: M6_QK.workflow(workflowId) });
      void queryClient.invalidateQueries({ queryKey: ["workflows", workflowId, "runs"] });
    },
  });
}
