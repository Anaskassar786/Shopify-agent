import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, Mail, Phone, ShoppingCart, Users } from "lucide-react";
import { AnimatedNumber, Badge, Card, CardBody, CardHeader, DataTable, EmptyState, formatMoney, SkeletonText, StatCard, type ColumnDef } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { formatDateTime } from "../lib/format";
import { useCustomerQuery, useStoreQuery } from "../lib/queries";
import type { OrderRow } from "../lib/api-types";
import { customerDisplayName } from "./CustomersPage";

export function CustomerDetailPage(): ReactNode {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = useCustomerQuery(id);
  const store = useStoreQuery();
  const currency = store.data?.store.currency ?? "USD";

  const orderColumns: readonly ColumnDef<OrderRow>[] = [
    {
      key: "name",
      header: "Order",
      cell: (row) => <span className="font-medium text-foreground">{row.name}</span>,
    },
    {
      key: "financial",
      header: "Payment",
      cell: (row) =>
        row.financialStatus !== null ? <Badge tone={row.financialStatus === "paid" ? "success" : row.financialStatus === "refunded" ? "danger" : "warning"}>{row.financialStatus}</Badge> : <span className="text-faint">—</span>,
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      cell: (row) => (
        <span className="tabular-nums font-medium text-foreground">
          {new Intl.NumberFormat("en-US", { style: "currency", currency: row.currency }).format(Number(row.totalPrice))}
        </span>
      ),
    },
    {
      key: "processed",
      header: "Processed",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.processedAt)}</span>,
    },
  ];

  const customer = detail.data?.customer;
  const metrics = detail.data?.metrics ?? null;

  return (
    <div>
      <Link
        to="/customers"
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
      >
        <ArrowRight className="size-3 rotate-180" aria-hidden /> Back to customers
      </Link>
      <QueryBoundary query={detail} loading={<SkeletonText lines={4} />}>
        {customer !== undefined && (
          <>
            <PageHeader
              title={customerDisplayName(customer)}
              subtitle={
                <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                  {customer.email !== null && (
                    <span className="inline-flex items-center gap-1.5"><Mail className="size-3.5" aria-hidden />{customer.email}</span>
                  )}
                  {customer.phone !== null && (
                    <span className="inline-flex items-center gap-1.5"><Phone className="size-3.5" aria-hidden />{customer.phone}</span>
                  )}
                  <Badge tone={customer.acceptsMarketing ? "success" : "neutral"}>
                    {customer.acceptsMarketing ? "Accepts marketing" : "No marketing"}
                  </Badge>
                </span>
              }
            />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Lifetime spend"
                icon={<Users className="size-4" aria-hidden />}
                value={<AnimatedNumber value={metrics?.totalSpentCents ?? 0} format={(v) => formatMoney(v, currency)} />}
              />
              <StatCard
                label="Orders"
                icon={<ShoppingCart className="size-4" aria-hidden />}
                value={<AnimatedNumber value={metrics?.ordersCount ?? customer.ordersCount} />}
              />
              <StatCard
                label="Avg. order value"
                value={<AnimatedNumber value={metrics?.aovCents ?? 0} format={(v) => formatMoney(v, currency)} />}
              />
              <StatCard
                label="First order"
                value={metrics?.firstOrderAt != null ? formatDateTime(metrics.firstOrderAt).split(",")[0] : "—"}
                hint={metrics?.lastOrderAt != null ? `latest ${formatDateTime(metrics.lastOrderAt)}` : "no orders yet"}
              />
            </div>
          </>
        )}
      </QueryBoundary>

      <Card className="mt-6">
        <CardHeader title="Recent orders" subtitle="Latest 10 orders from this customer" />
        <CardBody className="px-0 pb-0 pt-2">
          <DataTable
            columns={orderColumns}
            rows={detail.data?.recentOrders ?? []}
            rowKey={(row) => row.id}
            loading={detail.isPending}
            onRowClick={(row) => navigate(`/orders/${row.id}`)}
            emptyState={
              <EmptyState
                icon={<ShoppingCart className="size-6" aria-hidden />}
                title="No orders from this customer yet"
                body="Orders appear here as soon as they sync from Shopify."
              />
            }
          />
        </CardBody>
      </Card>
    </div>
  );
}
