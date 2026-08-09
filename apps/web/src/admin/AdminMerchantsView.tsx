import { useState, type ReactNode } from "react";
import { Badge, DataTable, formatMoney, type ColumnDef } from "@profit/ui";
import { AdminEmpty, AdminView } from "./AdminShared";
import { formatDate, formatRelativeTime } from "../lib/format";
import { formatCostMicros } from "../lib/micros";
import { useAdminMerchantsQuery } from "../lib/admin-queries";
import type { AdminMerchantRow } from "../lib/api-types";

const STATUS_TONE: Readonly<Record<string, "success" | "warning" | "danger" | "info" | "neutral">> = {
  TRIALING: "info",
  ACTIVE: "success",
  CHARGE_PENDING: "warning",
  TRIAL_EXPIRED: "warning",
  PAST_DUE: "danger",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  SUSPENDED: "danger",
};

/** Every merchant across tenants: plan, billing state, attributed value, engagement. */
export function AdminMerchantsView({ adminKey }: { readonly adminKey: string }): ReactNode {
  const [page, setPage] = useState(1);
  const query = useAdminMerchantsQuery({ adminKey }, page);
  const rows = query.data ?? [];

  const columns: readonly ColumnDef<AdminMerchantRow>[] = [
    {
      key: "shop",
      header: "Shop",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{row.name}</p>
          <p className="truncate text-xs text-faint">{row.shopDomain}</p>
        </div>
      ),
    },
    {
      key: "plan",
      header: "Plan",
      cell: (row) =>
        row.planCode === null ? (
          <span className="text-xs text-faint">none</span>
        ) : (
          <Badge tone="primary">{row.planCode}</Badge>
        ),
    },
    {
      key: "status",
      header: "Billing",
      cell: (row) =>
        row.subscriptionStatus === null ? (
          <span className="text-xs text-faint">—</span>
        ) : (
          <Badge tone={STATUS_TONE[row.subscriptionStatus] ?? "neutral"}>
            {row.subscriptionStatus.replaceAll("_", " ")}
          </Badge>
        ),
    },
    {
      key: "attributed",
      header: "Attributed revenue",
      align: "right",
      cell: (row) => <span className="tabular-nums">{formatMoney(row.attributedRevenueCents, "USD")}</span>,
    },
    {
      key: "aicost",
      header: "AI cost (30d)",
      align: "right",
      cell: (row) => <span className="tabular-nums">{formatCostMicros(row.aiCostMicrosLast30d)}</span>,
    },
    {
      key: "activity",
      header: "Last activity",
      cell: (row) => <span className="text-xs text-muted">{formatRelativeTime(row.lastActivityAt)}</span>,
    },
    {
      key: "installed",
      header: "Installed",
      cell: (row) => <span className="text-xs text-muted">{formatDate(row.installedAt)}</span>,
    },
  ];

  return (
    <AdminView
      title="Merchants"
      subtitle="Every installed store with plan, billing state, attributed value and engagement."
      query={query}
    >
      {rows.length === 0 && page === 1 ? (
        <AdminEmpty title="No merchants yet" body="Installed stores appear here the moment the first OAuth completes." />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.storeId}
          emptyState={<AdminEmpty title="No merchants on this page" body="Page through the list to find earlier installs." />}
          pagination={{ page, pageSize: 25, totalItems: page === 1 && rows.length < 25 ? rows.length : page * 25 + (rows.length === 25 ? 25 : 0), onPageChange: setPage }}
        />
      )}
    </AdminView>
  );
}
