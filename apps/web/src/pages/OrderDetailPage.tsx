import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, ShoppingCart } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, DataTable, EmptyState, SkeletonText, type ColumnDef } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { formatDateTime, formatDecimalMoney } from "../lib/format";
import { useOrderQuery } from "../lib/queries";
import type { LineItemRow } from "../lib/api-types";
import { FINANCIAL_STATUS_TONE } from "./OrdersPage";

export function OrderDetailPage(): ReactNode {
  const { id = "" } = useParams<{ id: string }>();
  const detail = useOrderQuery(id);
  const order = detail.data?.order;
  const currency = order?.currency ?? "USD";

  const columns: readonly ColumnDef<LineItemRow>[] = [
    {
      key: "title",
      header: "Item",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{row.title}</p>
          {row.sku !== null && <p className="font-mono text-[11px] text-faint">{row.sku}</p>}
        </div>
      ),
    },
    {
      key: "quantity",
      header: "Qty",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.quantity}</span>,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      cell: (row) => <span className="tabular-nums text-muted">{formatDecimalMoney(row.price, currency)}</span>,
    },
    {
      key: "lineTotal",
      header: "Line total",
      align: "right",
      cell: (row) => (
        <span className="tabular-nums font-medium text-foreground">
          {formatDecimalMoney((Number(row.price) * row.quantity).toFixed(2), currency)}
        </span>
      ),
    },
  ];

  const lineTotalSum = (detail.data?.lineItems ?? []).reduce(
    (acc, item) => acc + Number(item.price) * item.quantity,
    0,
  );

  return (
    <div>
      <Link
        to="/orders"
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
      >
        <ArrowRight className="size-3 rotate-180" aria-hidden /> Back to orders
      </Link>
      <QueryBoundary query={detail} loading={<SkeletonText lines={4} />}>
        {order !== undefined && (
          <>
            <PageHeader
              title={`Order ${order.name}`}
              subtitle={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {order.financialStatus !== null && (
                    <Badge tone={FINANCIAL_STATUS_TONE[order.financialStatus] ?? "neutral"}>
                      {order.financialStatus.replaceAll("_", " ")}
                    </Badge>
                  )}
                  <Badge tone={order.fulfillmentStatus === "fulfilled" ? "success" : "neutral"}>
                    {order.fulfillmentStatus?.replaceAll("_", " ") ?? "unfulfilled"}
                  </Badge>
                  <span>processed {formatDateTime(order.processedAt ?? order.createdAt)}</span>
                </span>
              }
            />
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader title="Line items" subtitle={`${String(detail.data?.lineItems.length ?? 0)} items in this order`} />
                <CardBody className="px-0 pb-0 pt-2">
                  <DataTable
                    columns={columns}
                    rows={detail.data?.lineItems ?? []}
                    rowKey={(row) => row.id}
                    emptyState={
                      <EmptyState
                        icon={<ShoppingCart className="size-6" aria-hidden />}
                        title="No line items synced"
                        body="Line items appear after the orders sync completes for this record."
                      />
                    }
                  />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Summary" />
                <CardBody className="flex flex-col gap-2.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Customer</span>
                    <span className="max-w-[60%] truncate font-medium text-foreground">{order.email ?? "Guest"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Items subtotal</span>
                    <span className="tabular-nums text-foreground">{formatDecimalMoney(lineTotalSum.toFixed(2), currency)}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-subtle pt-2.5">
                    <span className="font-medium text-foreground">Order total</span>
                    <span className="tabular-nums text-base font-semibold text-foreground">
                      {formatDecimalMoney(order.totalPrice, currency)}
                    </span>
                  </div>
                  {lineTotalSum > 0 && Math.abs(Number(order.totalPrice) - lineTotalSum) > 0.005 && (
                    <p className="text-[11px] leading-relaxed text-faint">
                      The difference between items and total is taxes, shipping and discounts — Shopify keeps
                      those at order level; they are included in the analytics pipeline.
                    </p>
                  )}
                </CardBody>
              </Card>
            </div>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
