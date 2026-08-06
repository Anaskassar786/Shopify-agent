import { useState, type ReactNode } from "react";
import { ScrollText } from "lucide-react";
import { Badge, DataTable, EmptyState, Input, Select, type ColumnDef } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../lib/format";
import { useAuditLogsQuery } from "../lib/queries";
import type { AuditLogRow } from "../lib/api-types";

export function AuditLogsPage(): ReactNode {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const logs = useAuditLogsQuery(page, action, result);

  const columns: readonly ColumnDef<AuditLogRow>[] = [
    {
      key: "action",
      header: "Action",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-medium text-foreground">{row.action}</p>
          {row.entityType !== null && (
            <p className="truncate text-[11px] text-faint">
              {row.entityType}
              {row.entityId !== null ? ` · ${row.entityId.slice(0, 8)}…` : ""}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "result",
      header: "Result",
      cell: (row) => <Badge tone={row.result === "SUCCESS" ? "success" : "danger"}>{row.result}</Badge>,
    },
    {
      key: "actor",
      header: "Actor",
      cell: (row) =>
        row.userId !== null ? (
          <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px]">{row.userId.slice(0, 8)}…</code>
        ) : (
          <span className="text-xs text-muted">system</span>
        ),
    },
    {
      key: "ip",
      header: "IP",
      cell: (row) => <span className="font-mono text-xs text-muted">{row.ip ?? "—"}</span>,
    },
    {
      key: "when",
      header: "When",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Audit logs"
        subtitle="Append-only trail of every authenticated action. Prefix filters are matched server-side."
      />
      <DataTable
        columns={columns}
        rows={logs.data?.items ?? []}
        rowKey={(row) => row.id}
        loading={logs.isPending}
        toolbar={
          <div className="flex w-full flex-wrap items-center gap-2">
            <Input
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setPage(1);
              }}
              placeholder="Action prefix… e.g. store.settings"
              aria-label="Filter by action prefix"
              className="max-w-64"
            />
            <Select
              value={result}
              onChange={(event) => {
                setResult(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by result"
              className="max-w-40"
            >
              <option value="">All results</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILURE">Failure</option>
            </Select>
          </div>
        }
        emptyState={
          <EmptyState
            icon={<ScrollText className="size-6" aria-hidden />}
            title="No audit entries match"
            body={
              action !== "" || result !== ""
                ? "Loosen the filters to see more of the trail."
                : "Entries appear as soon as anyone signs in, changes settings or runs a sync."
            }
          />
        }
        pagination={
          logs.data !== undefined
            ? {
                page: logs.data.page,
                pageSize: logs.data.pageSize,
                totalItems: logs.data.totalItems,
                onPageChange: setPage,
              }
            : undefined
        }
      />
    </div>
  );
}
