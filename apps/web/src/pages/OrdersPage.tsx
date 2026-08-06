import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ShoppingCart } from "lucide-react";
import { Badge, DataTable, EmptyState, Select, type BadgeTone, type ColumnDef } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime, formatDecimalMoney } from "../lib/format";
import { useOrdersQuery } from "../lib/queries";
import type { OrderRow } from "../lib/api-types";

export const FINANCIAL_STATUS_TONE: Record<string, BadgeTone> = {
  paid: "success",
  pending: "warning",
  authorized: "info",
  partially_paid: "warning",
  refunded: "danger",
  partially_refunded: "danger",
  voided: "neutral",
  unpaid: "warning",
  expired: "neutral",
};

const FINANCIAL_FILTERS = ["", "paid", "pending", "authorized", "partially_paid", "refunded", "partially_refunded", "voided", "unpaid"] as const;

export function OrdersPage(): ReactNode {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const orders = useOrdersQuery(page, status);

  const columns: readonly ColumnDef<OrderRow>[] = [
    {
      key: "name",
      header: "Order",
      cell: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">{row.name}</p>
          <p className="truncate text-[11px] text-faint">{row.email ?? "no email"}</p>
        </div>
      ),
    },
    {
      key: "financial",
      header: "Payment",
      cell: (row) =>
        row.financialStatus !== null ? (
          <Badge tone={FINANCIAL_STATUS_TONE[row.financialStatus] ?? "neutral"}>{row.financialStatus.replaceAll("_", " ")}</Badge>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: "fulfillment",
      header: "Fulfillment",
      cell: (row) =>
        row.fulfillmentStatus !== null ? (
          <Badge tone={row.fulfillmentStatus === "fulfilled" ? "success" : "neutral"}>{row.fulfillmentStatus.replaceAll("_", " ")}</Badge>
        ) : (
          <Badge tone="neutral">unfulfilled</Badge>
        ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      cell: (row) => <span className="tabular-nums font-medium text-foreground">{formatDecimalMoney(row.totalPrice, row.currency)}</span>,
    },
    {
      key: "processed",
      header: "Processed",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.processedAt ?? row.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Every synced order, newest first. Filter by payment state; drill in for line items."
      />
      <DataTable
        columns={columns}
        rows={orders.data?.items ?? []}
        rowKey={(row) => row.id}
        loading={orders.isPending}
        onRowClick={(row) => navigate(`/orders/${row.id}`)}
        toolbar={
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by payment status"
            className="max-w-56"
          >
            {FINANCIAL_FILTERS.map((option) => (
              <option key={option} value={option}>
                {option === "" ? "All payment statuses" : option.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        }
        emptyState={
          <EmptyState
            icon={<ShoppingCart className="size-6" aria-hidden />}
            title={status !== "" ? `No ${status.replaceAll("_", " ")} orders` : "No orders synced yet"}
            body={
              status !== ""
                ? "Try a different payment status filter."
                : "Run a sync from Settings → Sync and orders will stream in from Shopify."
            }
          />
        }
        pagination={
          orders.data !== undefined
            ? {
                page: orders.data.page,
                pageSize: orders.data.pageSize,
                totalItems: orders.data.totalItems,
                onPageChange: setPage,
              }
            : undefined
        }
      />
    </div>
  );
}
