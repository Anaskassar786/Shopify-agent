import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Users } from "lucide-react";
import { Badge, DataTable, EmptyState, Input, type ColumnDef } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { formatDecimalMoney } from "../lib/format";
import { useCustomersQuery, useStoreQuery } from "../lib/queries";
import type { CustomerRow } from "../lib/api-types";

export function customerDisplayName(customer: Pick<CustomerRow, "firstName" | "lastName" | "email">): string {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
  return name !== "" ? name : customer.email ?? "Guest customer";
}

export function CustomersPage(): ReactNode {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const customers = useCustomersQuery(page, search);
  const store = useStoreQuery();
  const currency = store.data?.store.currency ?? "USD";

  const columns: readonly ColumnDef<CustomerRow>[] = [
    {
      key: "name",
      header: "Customer",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{customerDisplayName(row)}</p>
          <p className="truncate text-[11px] text-faint">{row.email ?? row.phone ?? "no contact"}</p>
        </div>
      ),
    },
    {
      key: "orders",
      header: "Orders",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.ordersCount}</span>,
    },
    {
      key: "spent",
      header: "Total spent",
      align: "right",
      cell: (row) => (
        <span className="tabular-nums font-medium text-foreground">{formatDecimalMoney(row.totalSpent, currency)}</span>
      ),
    },
    {
      key: "marketing",
      header: "Marketing",
      cell: (row) =>
        row.acceptsMarketing ? <Badge tone="success">Subscribed</Badge> : <Badge tone="neutral">Not subscribed</Badge>,
    },
    {
      key: "tags",
      header: "Tags",
      cell: (row) =>
        row.tags.length === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <span className="text-xs text-muted">{row.tags.slice(0, 3).join(", ")}{row.tags.length > 3 ? ` +${String(row.tags.length - 3)}` : ""}</span>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Synced customers with lifetime value signals. Drill in for order history and metrics."
      />
      <DataTable
        columns={columns}
        rows={customers.data?.items ?? []}
        rowKey={(row) => row.id}
        loading={customers.isPending}
        onRowClick={(row) => navigate(`/customers/${row.id}`)}
        toolbar={
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search by name or email…"
              aria-label="Search customers"
              className="pl-9"
            />
          </div>
        }
        emptyState={
          <EmptyState
            icon={<Users className="size-6" aria-hidden />}
            title={search !== "" ? `No customers match "${search}"` : "No customers synced yet"}
            body={
              search !== ""
                ? "Search matches name and email — try a different spelling."
                : "Run a sync from Settings → Sync and Shopify customers will appear here with their spend."
            }
          />
        }
        pagination={
          customers.data !== undefined
            ? {
                page: customers.data.page,
                pageSize: customers.data.pageSize,
                totalItems: customers.data.totalItems,
                onPageChange: setPage,
              }
            : undefined
        }
      />
    </div>
  );
}
