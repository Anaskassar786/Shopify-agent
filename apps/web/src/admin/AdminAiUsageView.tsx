import type { ReactNode } from "react";
import { DataTable, type ColumnDef } from "@profit/ui";
import { AdminEmpty, AdminView } from "./AdminShared";
import { formatCostMicros } from "../lib/micros";
import { useAdminAiUsageQuery } from "../lib/admin-queries";
import type { AdminAiUsageRow } from "../lib/api-types";

/** Per-store metered AI consumption — the cost side of the platform ledger. */
export function AdminAiUsageView({ adminKey }: { readonly adminKey: string }): ReactNode {
  const query = useAdminAiUsageQuery({ adminKey });
  const rows = query.data ?? [];
  const totals = rows.reduce(
    (acc, row) => ({ calls: acc.calls + row.calls, tokens: acc.tokens + row.tokens, costMicros: acc.costMicros + row.costMicros }),
    { calls: 0, tokens: 0, costMicros: 0 },
  );

  const columns: readonly ColumnDef<AdminAiUsageRow>[] = [
    {
      key: "shop",
      header: "Shop",
      cell: (row) => <span className="font-medium text-foreground">{row.shopDomain}</span>,
    },
    {
      key: "calls",
      header: "AI calls",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.calls.toLocaleString("en-US")}</span>,
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.tokens.toLocaleString("en-US")}</span>,
    },
    {
      key: "cost",
      header: "Metered cost",
      align: "right",
      cell: (row) => <span className="tabular-nums">{formatCostMicros(row.costMicros)}</span>,
    },
  ];

  return (
    <AdminView
      title="AI usage by store"
      subtitle="Metered model consumption per merchant — the exact rows the usage ledger rolled up."
      query={query}
    >
      {rows.length === 0 ? (
        <AdminEmpty title="No AI usage metered yet" body="Consumption appears after the first engine run completes." />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-subtle bg-surface-raised/30 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Total calls</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{totals.calls.toLocaleString("en-US")}</p>
            </div>
            <div className="rounded-lg border border-subtle bg-surface-raised/30 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Total tokens</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{totals.tokens.toLocaleString("en-US")}</p>
            </div>
            <div className="rounded-lg border border-subtle bg-surface-raised/30 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Total metered cost</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{formatCostMicros(totals.costMicros)}</p>
            </div>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.storeId}
            emptyState={<AdminEmpty title="No AI usage" body="Consumption appears after the first engine run." />}
          />
        </div>
      )}
    </AdminView>
  );
}
