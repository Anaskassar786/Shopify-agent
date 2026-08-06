import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Boxes,
  CircleCheck,
  CircleDot,
  Clock,
  Database,
  ShoppingCart,
  Sparkles,
  TriangleAlert,
  Users,
} from "lucide-react";
import {
  AnimatedNumber,
  AreaChart,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  compactNumber,
  EmptyState,
  formatDateLabel,
  formatMoney,
  Gauge,
  HealthBar,
  Skeleton,
  Sparkline,
  StatCard,
  Tabs,
  useToast,
} from "@profit/ui";
import { QueryBoundary } from "../components/QueryBoundary";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatRelativeTime } from "../lib/format";
import { halfSplitDelta, formatDelta } from "../lib/series";
import {
  useAiOverviewQuery,
  useAnalyticsSummaryQuery,
  useAuditLogsQuery,
  useInventoryLevelsQuery,
  useRecommendationsQuery,
  useRunAnalysisMutation,
  useSyncStatusQuery,
  useTopCustomersQuery,
  useTopProductsQuery,
} from "../lib/queries";
import { PRIORITY_TONE, priorityLabel, recommendationTypeLabel } from "./ai-shared";

const RANGE_OPTIONS = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
] as const;

/** Health roll-up for the store tile: real sync module states, real counts. */
function StoreHealthCard(): ReactNode {
  const sync = useSyncStatusQuery();
  return (
    <Card>
      <CardHeader
        title="Store health"
        subtitle="Data pipeline freshness across every synced module"
        actions={
          <Link
            to="/settings?tab=sync"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-strong"
          >
            Manage sync <ArrowRight className="size-3" aria-hidden />
          </Link>
        }
      />
      <CardBody>
        <QueryBoundary query={sync} compact>
          {(() => {
            const modules = sync.data?.modules ?? [];
            const counts = {
              completed: modules.filter((m) => m.status === "COMPLETED").length,
              running: modules.filter((m) => m.status === "RUNNING").length,
              pending: modules.filter((m) => m.status === "PENDING" || m.finishedAt === null).length,
              failed: modules.filter((m) => m.status === "FAILED").length,
            };
            const lastFinished = modules
              .map((m) => m.finishedAt)
              .filter((v): v is string => v !== null)
              .sort()
              .at(-1);
            return (
              <div className="flex flex-col gap-4">
                <HealthBar
                  segments={[
                    { label: "Synced", tone: "success", count: counts.completed },
                    { label: "Running", tone: "muted", count: counts.running },
                    { label: "Pending", tone: "warning", count: counts.pending },
                    { label: "Failed", tone: "danger", count: counts.failed },
                  ]}
                />
                <p className="flex items-center gap-1.5 text-xs text-muted">
                  <Clock className="size-3.5" aria-hidden />
                  {lastFinished !== undefined
                    ? `Last successful sync ${formatRelativeTime(lastFinished)}`
                    : "Waiting for the first sync to complete"}
                </p>
                {counts.failed > 0 && (
                  <p className="flex items-start gap-1.5 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {counts.failed} module{counts.failed === 1 ? "" : "s"} failed — review and retry in Settings → Sync.
                  </p>
                )}
              </div>
            );
          })()}
        </QueryBoundary>
      </CardBody>
    </Card>
  );
}

/** Recent activity: the real audit trail (permission-gated, like the API). */
function RecentActivityCard(): ReactNode {
  const activity = useAuditLogsQuery(1, "", "");
  return (
    <Card>
      <CardHeader
        title="Recent activity"
        subtitle="Latest events recorded in your audit trail"
        actions={
          <Link
            to="/audit-logs"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-strong"
          >
            View all <ArrowRight className="size-3" aria-hidden />
          </Link>
        }
      />
      <CardBody>
        <QueryBoundary query={activity} compact>
          {(activity.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Activity className="size-6" aria-hidden />}
              title="No activity yet"
              body="Actions like syncs, settings changes and sign-ins will appear here as they happen."
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {activity.data?.items.map((row) => (
                <li key={row.id} className="flex items-start gap-2.5 text-[13px]">
                  <CircleDot
                    className={`mt-0.5 size-3.5 shrink-0 ${row.result === "SUCCESS" ? "text-success" : "text-danger"}`}
                    aria-label={row.result === "SUCCESS" ? "Succeeded" : "Failed"}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{row.action}</p>
                    <p className="text-xs text-faint">{formatRelativeTime(row.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </CardBody>
    </Card>
  );
}

/** Low-stock alerts from the real inventory feed. */
function InventoryAlertsCard({ currency }: { readonly currency: string }): ReactNode {
  const navigate = useNavigate();
  void currency;
  const lowStock = useInventoryLevelsQuery(1, 5);
  return (
    <Card>
      <CardHeader
        title="Inventory alerts"
        subtitle="Variants at or below 5 units across all locations"
        actions={
          <Link
            to="/inventory"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-strong"
          >
            Open inventory <ArrowRight className="size-3" aria-hidden />
          </Link>
        }
      />
      <CardBody>
        <QueryBoundary query={lowStock} compact>
          {(lowStock.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              icon={<CircleCheck className="size-6 text-success" aria-hidden />}
              title="Stock looks healthy"
              body="No variant is at or below 5 units right now."
            />
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted">
                <span className="font-semibold text-warning">{lowStock.data?.totalItems ?? 0}</span> stock level
                {(lowStock.data?.totalItems ?? 0) === 1 ? "" : "s"} need attention.
              </p>
              {lowStock.data?.items.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => navigate("/inventory")}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-subtle bg-surface-raised/40 px-3 py-2 text-left transition-colors hover:border-strong focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {row.productTitle}
                      {row.variantTitle !== null ? ` — ${row.variantTitle}` : ""}
                    </span>
                    <span className="block text-[11px] text-faint">{row.sku ?? row.locationName}</span>
                  </span>
                  <Badge tone={row.available <= 0 ? "danger" : "warning"}>
                    {row.available} left
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </QueryBoundary>
      </CardBody>
    </Card>
  );
}

/**
 * M4 AI insights tile: engine health score + the highest-priority decisions
 * waiting for the merchant, with a first-run CTA when the engine has never
 * run (zero state is content, not a placeholder).
 */
function AiInsightsCard(): ReactNode {
  const overview = useAiOverviewQuery();
  const pending = useRecommendationsQuery({ page: 1, status: "PENDING_APPROVAL", priority: "", type: "" });
  const run = useRunAnalysisMutation();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canRun = hasPermission("recommendations:approve");

  const busy = run.isPending;
  const topPending = (pending.data?.items ?? [])
    .filter((rec) => rec.priority === "CRITICAL" || rec.priority === "HIGH")
    .slice(0, 3);

  const onRun = (): void => {
    run.mutate(undefined, {
      onSuccess: () => toast.success("Analysis is running", "New recommendations land here the moment they are ready."),
      onError: (error: ApiError) => toast.error("Analysis could not start", error.message),
    });
  };

  return (
    <Card>
      <CardHeader
        title="AI insights"
        subtitle="Engine health and your highest-priority decisions"
        actions={
          <Link
            to="/ai"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-strong"
          >
            Command center <ArrowRight className="size-3" aria-hidden />
          </Link>
        }
      />
      <CardBody>
        <QueryBoundary query={overview} compact>
          {overview.data?.engine.lastRunAt === null || overview.data === undefined ? (
            <EmptyState
              icon={<Sparkles className="size-6" aria-hidden />}
              title="No analysis yet"
              body="The AI engine will read your synced store data and propose revenue actions. It decides nothing on its own until you approve."
              primaryAction={
                canRun ? (
                  <Button size="sm" onClick={onRun} loading={busy}>Run your first analysis</Button>
                ) : undefined
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                {overview.data.health.score !== null ? (
                  <Gauge
                    value={overview.data.health.score}
                    label="Store score"
                    tone={overview.data.health.score >= 70 ? "success" : overview.data.health.score >= 40 ? "warning" : "danger"}
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-muted">
                    {overview.data.open.pendingApproval === 0
                      ? "Nothing waiting on you — the next scheduled analysis keeps watch."
                      : `${String(overview.data.open.pendingApproval)} recommendation${overview.data.open.pendingApproval === 1 ? "" : "s"} waiting for your decision.`}
                  </p>
                  {overview.data.outcomes.attributedRevenueCents > 0 && (
                    <p className="mt-1 text-xs text-success">
                      {formatMoney(overview.data.outcomes.attributedRevenueCents)} attributed to approved actions so far.
                    </p>
                  )}
                </div>
              </div>
              {topPending.length > 0 && (
                <ul className="flex flex-col divide-y divide-subtle" aria-label="Top pending recommendations">
                  {topPending.map((rec) => (
                    <li key={rec.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <Link to={`/recommendations/${rec.id}`} className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground hover:text-primary">{rec.title}</p>
                        <p className="truncate text-[11px] text-faint">
                          {recommendationTypeLabel(rec.type)} · +{formatMoney(rec.estimatedRevenueCents)} est.
                        </p>
                      </Link>
                      <Badge tone={PRIORITY_TONE[rec.priority] ?? "neutral"}>{priorityLabel(rec.priority)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                to="/recommendations"
                className="inline-flex items-center gap-1 self-start text-xs font-medium text-primary transition-colors hover:text-primary-strong"
              >
                Review recommendations <ArrowRight className="size-3" aria-hidden />
              </Link>
            </div>
          )}
        </QueryBoundary>
      </CardBody>
    </Card>
  );
}

export function DashboardPage(): ReactNode {
  const { hasPermission } = useAuth();
  const [days, setDays] = useState<number>(30);
  const summary = useAnalyticsSummaryQuery(days);
  const topProducts = useTopProductsQuery(days);
  const topCustomers = useTopCustomersQuery(days);
  const canReadAudit = hasPermission("audit:read");
  const canReadInventory = hasPermission("inventory:read");
  const canReadRecommendations = hasPermission("recommendations:read");

  const totals = summary.data?.totals;
  const series = summary.data?.series ?? [];
  const currency = totals?.currency ?? "USD";
  const allZeros = totals !== undefined && totals.ordersCount === 0 && totals.grossSalesCents === 0;

  const revenueSeries = series.map((d) => d.netSalesCents);
  const ordersSeries = series.map((d) => d.ordersCount);
  const customersSeries = series.map((d) => d.newCustomers);
  const xLabels = series.map((d) => formatDateLabel(d.date));

  const stats = [
    {
      key: "revenue",
      label: "Net revenue",
      icon: <Sparkles className="size-4" aria-hidden />,
      value: totals?.netSalesCents ?? 0,
      format: (v: number) => formatMoney(v, currency),
      series: revenueSeries,
      hint: `after ${formatMoney(totals?.refundsCents ?? 0, currency)} refunds`,
    },
    {
      key: "orders",
      label: "Orders",
      icon: <ShoppingCart className="size-4" aria-hidden />,
      value: totals?.ordersCount ?? 0,
      format: (v: number) => v.toLocaleString("en-US"),
      series: ordersSeries,
      hint: `${String(totals?.itemsSold ?? 0)} items sold`,
    },
    {
      key: "customers",
      label: "New customers",
      icon: <Users className="size-4" aria-hidden />,
      value: totals?.newCustomers ?? 0,
      format: (v: number) => v.toLocaleString("en-US"),
      series: customersSeries,
      hint: `${String(totals?.returningCustomers ?? 0)} returning`,
    },
    {
      key: "aov",
      label: "Avg. order value",
      icon: <Activity className="size-4" aria-hidden />,
      value: totals?.aovCents ?? 0,
      format: (v: number) => formatMoney(v, currency),
      series: ordersSeries.map((count, i) => (count === 0 ? 0 : (revenueSeries[i] ?? 0) / count)),
      hint: `gross ${formatMoney(totals?.grossSalesCents ?? 0, currency)}`,
    },
  ] as const;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="How your store is performing — computed live from your synced Shopify data."
        actions={
          <Tabs
            items={RANGE_OPTIONS.map((option) => ({ key: option.key, label: option.label }))}
            active={String(days)}
            onChange={(key) => setDays(Number(key))}
          />
        }
      />

      <QueryBoundary
        query={summary}
        loading={
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-lg border border-subtle bg-surface-solid p-5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-3 h-8 w-2/3" />
                <Skeleton className="mt-3 h-9 w-full" />
              </div>
            ))}
          </div>
        }
      >
        {allZeros ? (
          <Card className="mb-6">
            <EmptyState
              icon={<Database className="size-6" aria-hidden />}
              title="No sales data in this range yet"
              body="Once your store finishes syncing, revenue, orders and customers are computed here automatically — this panel never shows sample numbers."
              primaryAction={
                <Link
                  to="/settings?tab=sync"
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-on-primary transition-colors hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <Database className="size-4" aria-hidden /> Check sync status
                </Link>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((stat) => {
              const delta = formatDelta(halfSplitDelta(stat.series));
              const direction = halfSplitDelta(stat.series)?.direction;
              return (
                <StatCard
                  key={stat.key}
                  label={stat.label}
                  icon={stat.icon}
                  value={<AnimatedNumber value={stat.value} format={stat.format} />}
                  delta={delta !== null ? `${delta} 2nd half vs 1st` : undefined}
                  deltaTone={direction}
                  hint={delta === null ? stat.hint : undefined}
                  chart={stat.series.length > 1 ? <Sparkline values={stat.series} /> : undefined}
                />
              );
            })}
          </div>
        )}
      </QueryBoundary>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        {!allZeros && (
          <Card className="xl:col-span-2">
            <CardHeader title="Revenue trend" subtitle={`Net sales per day · last ${String(days)} days`} />
            <CardBody>
              <QueryBoundary query={summary} compact>
                <AreaChart
                  series={[{ label: "Net revenue", values: revenueSeries }]}
                  xLabels={xLabels}
                  formatY={(v) => compactNumber(v / 100)}
                  testId="revenue-trend"
                />
              </QueryBoundary>
            </CardBody>
          </Card>
        )}
        <StoreHealthCard />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {!allZeros && (
          <>
            <Card>
              <CardHeader title="Orders" subtitle="Per day in range" />
              <CardBody>
                <QueryBoundary query={summary} compact>
                  <AreaChart series={[{ label: "Orders", values: ordersSeries }]} xLabels={xLabels} height={160} />
                </QueryBoundary>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Customer growth" subtitle="New customers per day" />
              <CardBody>
                <QueryBoundary query={summary} compact>
                  <AreaChart series={[{ label: "New customers", values: customersSeries }]} xLabels={xLabels} height={160} />
                </QueryBoundary>
              </CardBody>
            </Card>
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {canReadRecommendations && <AiInsightsCard />}
        {canReadAudit ? <RecentActivityCard /> : canReadInventory ? <InventoryAlertsCard currency={currency} /> : null}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Top products"
            subtitle={`By revenue · last ${String(days)} days`}
            actions={
              <Link to="/products" className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-strong">
                Catalog <ArrowRight className="size-3" aria-hidden />
              </Link>
            }
          />
          <CardBody>
            <QueryBoundary query={topProducts} compact>
              {(topProducts.data?.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<Boxes className="size-6" aria-hidden />}
                  title="No product sales in range"
                  body="Your best sellers appear here once orders start flowing through sync."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {topProducts.data?.map((row, index) => (
                    <li key={row.productId} className="flex items-center gap-3 text-[13px]">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-raised text-[11px] font-bold text-muted">
                        {index + 1}
                      </span>
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
          <CardHeader
            title="Top customers"
            subtitle="By lifetime spend"
            actions={
              <Link to="/customers" className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-strong">
                Customers <ArrowRight className="size-3" aria-hidden />
              </Link>
            }
          />
          <CardBody>
            <QueryBoundary query={topCustomers} compact>
              {(topCustomers.data?.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<Users className="size-6" aria-hidden />}
                  title="No customer data yet"
                  body="Highest-value customers are ranked here after your first sync."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {topCustomers.data?.map((row, index) => {
                    const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email || "Guest";
                    return (
                      <li key={row.customerId} className="flex items-center gap-3 text-[13px]">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-raised text-[11px] font-bold text-muted">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">{name}</span>
                          <span className="block truncate text-[11px] text-faint">{row.ordersCount} orders</span>
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

      {canReadAudit && canReadInventory && (
        <div className="mt-4">
          <InventoryAlertsCard currency={currency} />
        </div>
      )}
    </div>
  );
}
