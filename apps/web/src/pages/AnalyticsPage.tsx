import { useState, type ReactNode } from "react";
import { Boxes, Users } from "lucide-react";
import { Link } from "react-router-dom";
import {
  AnimatedNumber,
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  compactNumber,
  EmptyState,
  formatDateLabel,
  formatMoney,
  StatCard,
  Tabs,
} from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import {
  useAnalyticsSummaryQuery,
  useTopCustomersQuery,
  useTopProductsQuery,
} from "../lib/queries";

const RANGE_OPTIONS = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
] as const;

/** Full analytics surface — the same live pipelines as the dashboard hero, expanded. */
export function AnalyticsPage(): ReactNode {
  const [days, setDays] = useState<number>(30);
  const summary = useAnalyticsSummaryQuery(days);
  const topProducts = useTopProductsQuery(days);
  const topCustomers = useTopCustomersQuery(days);

  const totals = summary.data?.totals;
  const series = summary.data?.series ?? [];
  const currency = totals?.currency ?? "USD";
  const xLabels = series.map((d) => formatDateLabel(d.date));

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Sales, refunds, discounts and customer mix — aggregated daily by the metrics pipeline."
        actions={
          <Tabs
            items={RANGE_OPTIONS.map((option) => ({ key: option.key, label: option.label }))}
            active={String(days)}
            onChange={(key) => setDays(Number(key))}
          />
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Gross sales"
          loading={summary.isPending}
          value={<AnimatedNumber value={totals?.grossSalesCents ?? 0} format={(v) => formatMoney(v, currency)} />}
          hint={`discounts ${formatMoney(totals?.discountsCents ?? 0, currency)}`}
        />
        <StatCard
          label="Net sales"
          loading={summary.isPending}
          value={<AnimatedNumber value={totals?.netSalesCents ?? 0} format={(v) => formatMoney(v, currency)} />}
          hint={`refunds ${formatMoney(totals?.refundsCents ?? 0, currency)}`}
        />
        <StatCard
          label="Orders"
          loading={summary.isPending}
          value={<AnimatedNumber value={totals?.ordersCount ?? 0} />}
          hint={`${String(totals?.cancelledOrders ?? 0)} cancelled`}
        />
        <StatCard
          label="Avg. order value"
          loading={summary.isPending}
          value={<AnimatedNumber value={totals?.aovCents ?? 0} format={(v) => formatMoney(v, currency)} />}
          hint={`taxes ${formatMoney(totals?.taxesCents ?? 0, currency)} · shipping ${formatMoney(totals?.shippingCents ?? 0, currency)}`}
        />
      </div>

      <Card className="mt-6">
        <CardHeader title="Net revenue vs refunds" subtitle={`Daily · last ${String(days)} days`} />
        <CardBody>
          <QueryBoundary query={summary}>
            <AreaChart
              series={[
                { label: "Net revenue", values: series.map((d) => d.netSalesCents) },
                { label: "Refunds", values: series.map((d) => d.refundsCents) },
              ]}
              xLabels={xLabels}
              formatY={(v) => compactNumber(v / 100)}
              height={260}
              testId="analytics-trend"
            />
          </QueryBoundary>
        </CardBody>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Orders & items" subtitle="Volume per day" />
          <CardBody>
            <QueryBoundary query={summary} compact>
              <AreaChart
                series={[
                  { label: "Orders", values: series.map((d) => d.ordersCount) },
                  { label: "Items", values: series.map((d) => d.itemsSold) },
                ]}
                xLabels={xLabels}
                height={200}
              />
            </QueryBoundary>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Customer mix" subtitle="New vs returning, per day in range" />
          <CardBody>
            <QueryBoundary query={summary} compact>
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-subtle bg-surface-raised/40 px-4 py-3">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted">New</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                    <AnimatedNumber value={totals?.newCustomers ?? 0} />
                  </p>
                </div>
                <div className="rounded-lg border border-subtle bg-surface-raised/40 px-4 py-3">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Returning</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                    <AnimatedNumber value={totals?.returningCustomers ?? 0} />
                  </p>
                </div>
              </div>
              <AreaChart
                series={[{ label: "New customers", values: series.map((d) => d.newCustomers) }]}
                xLabels={xLabels}
                height={150}
              />
            </QueryBoundary>
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Top products"
            subtitle={`By revenue · last ${String(days)} days`}
          />
          <CardBody>
            <QueryBoundary query={topProducts} compact>
              {(topProducts.data?.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<Boxes className="size-6" aria-hidden />}
                  title="No product sales in range"
                  body="Products ranked by real revenue appear here after orders sync."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {topProducts.data?.map((row) => (
                    <li key={row.productId} className="flex items-center gap-3 text-[13px]">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.title}</span>
                      <span className="shrink-0 text-xs text-muted">{row.unitsSold} sold</span>
                      <span className="shrink-0 font-semibold tabular-nums text-foreground">
                        {formatMoney(row.revenueCents, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </QueryBoundary>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Top customers" subtitle="By lifetime spend" />
          <CardBody>
            <QueryBoundary query={topCustomers} compact>
              {(topCustomers.data?.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<Users className="size-6" aria-hidden />}
                  title="No customer data yet"
                  body="Your highest-value customers are ranked here from the metrics pipeline."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {topCustomers.data?.map((row) => {
                    const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email || "Guest";
                    return (
                      <li key={row.customerId} className="flex items-center gap-3 text-[13px]">
                        <span className="min-w-0 flex-1">
                          <Link
                            to={`/customers/${row.customerId}`}
                            className="block truncate font-medium text-foreground transition-colors hover:text-primary"
                          >
                            {name}
                          </Link>
                          <span className="block text-[11px] text-faint">{row.ordersCount} orders</span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums text-foreground">
                          {formatMoney(row.totalSpentCents, currency)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </QueryBoundary>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
