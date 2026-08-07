import { useState, type ReactNode } from "react";
import { Badge, DataTable, Drawer, EmptyState, SkeletonText, type ColumnDef } from "@profit/ui";
import { History } from "lucide-react";
import { QueryBoundary } from "../../components/QueryBoundary";
import { formatDateTime } from "../../lib/format";
import { useWorkflowRunStepsQuery, useWorkflowRunsQuery } from "../../lib/workflow-queries";
import type { WorkflowRunRowDto, WorkflowRunStepRowDto } from "../../lib/api-types";

const RUN_STATUS_TONE: Record<string, "success" | "danger" | "info" | "warning" | "neutral"> = {
  COMPLETED: "success",
  FAILED: "danger",
  RUNNING: "info",
  WAITING: "warning",
  CANCELLED: "neutral",
};

const STEP_STATUS_TONE: Record<string, "success" | "danger" | "info" | "warning" | "neutral"> = {
  COMPLETED: "success",
  FAILED: "danger",
  RUNNING: "info",
  PENDING: "neutral",
  SKIPPED: "warning",
};

function stepDetail(detail: unknown): string | null {
  if (detail === null || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record["branch"] === "string") parts.push(`branch ${record["branch"]}`);
  if (typeof record["outcome"] === "string") parts.push(record["outcome"]);
  if (typeof record["to"] === "string") parts.push(`→ ${record["to"]}`);
  if (typeof record["minutes"] === "number") parts.push(`${String(record["minutes"])} min`);
  if (typeof record["tag"] === "string") parts.push(`tag “${record["tag"]}”`);
  if (typeof record["code"] === "string") parts.push(`code ${record["code"]}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Run ledger for one workflow (M6): paged, self-polling while runs are live. */
export function WorkflowRunsPanel({ workflowId }: { readonly workflowId: string }): ReactNode {
  const [page, setPage] = useState(1);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const runs = useWorkflowRunsQuery(workflowId, page);
  const detail = useWorkflowRunStepsQuery(workflowId, openRunId);

  const activeRuns = (runs.data?.runs ?? []).some((run) => run.status === "RUNNING" || run.status === "WAITING");

  const columns: readonly ColumnDef<WorkflowRunRowDto>[] = [
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <div>
          <Badge tone={RUN_STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge>
          {row.error !== null && <p className="mt-1 max-w-72 truncate text-[11px] text-danger">{row.error}</p>}
        </div>
      ),
    },
    {
      key: "trigger",
      header: "Started by",
      cell: (row) => (
        <span className="text-xs text-muted">
          {row.triggerKind.toLowerCase()}
          {row.resumeAt !== null && row.status === "WAITING" ? ` · resumes ${formatDateTime(row.resumeAt)}` : ""}
        </span>
      ),
    },
    {
      key: "when",
      header: "Started",
      align: "right",
      cell: (row) => (
        <span className="text-xs text-muted">{row.startedAt !== null ? formatDateTime(row.startedAt) : "—"}</span>
      ),
    },
  ];

  const stepColumns: readonly ColumnDef<WorkflowRunStepRowDto>[] = [
    {
      key: "node",
      header: "Node",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-medium text-foreground">{row.nodeId}</p>
          <p className="truncate text-[11px] text-faint">{row.nodeKind.toLowerCase().replaceAll("_", " ")}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <div>
          <Badge tone={STEP_STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge>
          {row.error !== null && <p className="mt-1 max-w-64 whitespace-pre-wrap text-[11px] text-danger">{row.error}</p>}
        </div>
      ),
    },
    {
      key: "detail",
      header: "Detail",
      cell: (row) => <span className="text-xs text-muted">{stepDetail(row.detail) ?? "—"}</span>,
    },
    {
      key: "when",
      header: "When",
      align: "right",
      cell: (row) => (
        <span className="text-xs text-muted">{row.completedAt !== null ? formatDateTime(row.completedAt) : row.startedAt !== null ? formatDateTime(row.startedAt) : "—"}</span>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted">
          Every run is recorded with per-node outcomes — nothing executes off the books.
          {activeRuns ? " Refreshing live…" : ""}
        </p>
      </div>
      <DataTable
        columns={columns}
        rows={runs.data?.runs ?? []}
        rowKey={(row) => row.id}
        loading={runs.isPending}
        onRowClick={(row) => setOpenRunId(row.id)}
        emptyState={
          <EmptyState
            icon={<History className="size-6" aria-hidden />}
            title="No runs yet"
            body="Activate the workflow and run it once — or wait for its trigger — and the full walk lands here."
          />
        }
        pagination={
          runs.data !== undefined
            ? { page, pageSize: 10, totalItems: runs.data.total, onPageChange: setPage }
            : undefined
        }
      />
      <Drawer open={openRunId !== null} onClose={() => setOpenRunId(null)} title="Run detail">
        <QueryBoundary query={detail} loading={<SkeletonText lines={5} />}>
          {detail.data !== undefined && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Badge tone={RUN_STATUS_TONE[detail.data.run.status] ?? "neutral"}>{detail.data.run.status}</Badge>
                <span className="text-xs text-muted">
                  {detail.data.run.triggerKind.toLowerCase()} · {detail.data.run.startedAt !== null ? formatDateTime(detail.data.run.startedAt) : "queued"}
                </span>
              </div>
              {detail.data.run.error !== null && (
                <p className="rounded-md bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">{detail.data.run.error}</p>
              )}
              <DataTable
                columns={stepColumns}
                rows={detail.data.steps}
                rowKey={(row) => row.id}
                emptyState={
                  <EmptyState icon={<History className="size-6" aria-hidden />} title="No steps recorded" body="The executor writes one row per node as it walks." />
                }
              />
            </div>
          )}
        </QueryBoundary>
      </Drawer>
    </div>
  );
}
