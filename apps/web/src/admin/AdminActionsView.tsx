import { useState, type ReactNode } from "react";
import { Button, DataTable, type ColumnDef } from "@profit/ui";
import { AdminEmpty, AdminView } from "./AdminShared";
import { formatDateTime } from "../lib/format";
import { useAdminActionsQuery } from "../lib/admin-queries";
import type { AdminActionRowDto } from "../lib/api-types";

/**
 * Operator action log (M6): the admin surface's own cross-tenant audit
 * trail. Payloads are stored as hashes server-side — the log proves WHO did
 * WHAT to WHICH target without leaking support-ticket text into broad views.
 */
export function AdminActionsView({ adminKey }: { readonly adminKey: string }): ReactNode {
  const [page, setPage] = useState(1);
  const query = useAdminActionsQuery({ adminKey }, page);

  const columns: readonly ColumnDef<AdminActionRowDto>[] = [
    {
      key: "operator",
      header: "Operator",
      cell: (row) => <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-foreground">{row.operatorId}</code>,
    },
    {
      key: "action",
      header: "Action",
      cell: (row) => <span className="font-mono text-xs text-foreground">{row.action}</span>,
    },
    {
      key: "target",
      header: "Target",
      cell: (row) => (
        <span className="text-xs text-muted">
          {row.targetType} · <code className="font-mono">{row.targetId.slice(0, 8)}…</code>
          {row.storeId !== null ? ` · store ${row.storeId.slice(0, 8)}…` : ""}
        </span>
      ),
    },
    {
      key: "payload",
      header: "Payload hash",
      cell: (row) => <code className="font-mono text-[11px] text-faint">{row.payloadHash.slice(0, 12)}…</code>,
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
    <AdminView
      title="Operator action log"
      subtitle="Every key gate probe and step-up write, tamper-evident by construction (payload hashes, no secrets)."
      query={query}
    >
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        rowKey={(row) => row.id}
        emptyState={
          <AdminEmpty
            title="No actions recorded yet"
            body="Session unlocks, ticket transitions, trial extensions and access overrides land here as they happen."
          />
        }
      />
      {/* The endpoint deliberately reports no total: page by returned length, no fabricated counts. */}
      <div className="mt-3 flex items-center justify-between">
        <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </Button>
        <span className="text-xs text-muted">Page {page}</span>
        <Button variant="secondary" size="sm" disabled={(query.data?.length ?? 0) < 50} onClick={() => setPage((p) => p + 1)}>
          Next
        </Button>
      </div>
    </AdminView>
  );
}
