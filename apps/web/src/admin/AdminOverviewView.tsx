import type { ReactNode } from "react";
import { Activity, BrainCircuit, CircleDollarSign, ServerCog, Store, Users } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, StatCard, formatMoney } from "@profit/ui";
import { AdminView } from "./AdminShared";
import { formatCostMicros } from "../lib/micros";
import { useAdminOverviewQuery } from "../lib/admin-queries";
import type { FunnelStepRow } from "../lib/api-types";

/** Human labels for the funnel milestone kinds the ledger emits. */
const FUNNEL_LABEL: Readonly<Record<string, string>> = {
  STORE_CONNECTED: "Store connected",
  FIRST_SYNC_COMPLETED: "First sync completed",
  FIRST_AI_RUN_COMPLETED: "First AI run completed",
  FIRST_AI_INSIGHT_VIEWED: "First AI insight viewed",
  FIRST_RECOMMENDATION_APPROVED: "First approval",
  FIRST_AUTOMATION_ENABLED: "First automation enabled",
  PAID_SUBSCRIPTION_STARTED: "Paid subscription",
};

const SUB_TONE: Readonly<Record<string, "success" | "warning" | "danger" | "info" | "neutral">> = {
  trialing: "info",
  active: "success",
  chargePending: "warning",
  trialExpired: "warning",
  cancelled: "neutral",
  suspended: "danger",
};

const SUB_LABEL: Readonly<Record<string, string>> = {
  trialing: "Trialing",
  active: "Active",
  chargePending: "Charge pending",
  trialExpired: "Trial expired",
  cancelled: "Cancelled",
  suspended: "Suspended",
};

export function AdminOverviewView({ adminKey }: { readonly adminKey: string }): ReactNode {
  const query = useAdminOverviewQuery({ adminKey });
  const data = query.data;

  return (
    <AdminView
      title="Platform overview"
      subtitle="Merchants, subscriptions, modeled revenue and system health — cross-tenant, read-only."
      query={query}
    >
      {data !== undefined && (
        <div className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Merchants"
              icon={<Store className="size-4" aria-hidden />}
              value={data.dashboard.merchants.total}
              hint={`${data.dashboard.merchants.active} active · ${data.dashboard.merchants.uninstalled} uninstalled`}
            />
            <StatCard
              label="Modeled MRR"
              icon={<CircleDollarSign className="size-4" aria-hidden />}
              value={formatMoney(data.dashboard.modeledMrrCents, "USD")}
              hint={`${formatMoney(data.dashboard.modeledArrCents, "USD")} modeled ARR — computed from active subs, not payouts`}
            />
            <StatCard
              label="AI runs (7d)"
              icon={<BrainCircuit className="size-4" aria-hidden />}
              value={data.dashboard.ai.runsLast7d}
              hint={`${formatCostMicros(data.dashboard.ai.costMicrosLast7d)} · ${data.dashboard.ai.tokensLast7d.toLocaleString("en-US")} tokens`}
            />
            <StatCard
              label="Queue health"
              icon={<ServerCog className="size-4" aria-hidden />}
              value={`${data.dashboard.system.jobsRunning} running`}
              hint={`${data.dashboard.system.jobsPending} pending · ${data.dashboard.system.jobsFailed} failed · ${data.dashboard.system.deadJobs} dead`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title={
                  <span className="inline-flex items-center gap-2">
                    <Users className="size-4 text-primary" aria-hidden /> Subscription states
                  </span>
                }
                subtitle="Live counts per subscription status — the revenue funnel's denominator."
              />
              <CardBody>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {(
                    [
                      "trialing",
                      "active",
                      "chargePending",
                      "trialExpired",
                      "cancelled",
                      "suspended",
                    ] as const
                  ).map((key) => (
                    <li key={key} className="rounded-lg border border-subtle bg-surface-raised/30 px-3.5 py-3">
                      <Badge tone={SUB_TONE[key] ?? "neutral"}>{SUB_LABEL[key]}</Badge>
                      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                        {data.dashboard.subscriptions[key]}
                      </p>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="inline-flex items-center gap-2">
                    <Activity className="size-4 text-ai" aria-hidden /> Activation funnel
                  </span>
                }
                subtitle="Deduped milestone events per store — install to paid, step by step."
              />
              <CardBody>
                <ol className="flex flex-col gap-2.5">
                  {data.funnel.map((step) => (
                    <FunnelStep key={step.kind} step={step} />
                  ))}
                </ol>
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </AdminView>
  );
}

function FunnelStep({ step }: { readonly step: FunnelStepRow }): ReactNode {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-subtle bg-surface-raised/30 px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {FUNNEL_LABEL[step.kind] ?? step.kind.replaceAll("_", " ").toLowerCase()}
        </p>
        {step.conversionFromPreviousPct !== null && (
          <p className="text-xs text-faint">{step.conversionFromPreviousPct}% from previous step</p>
        )}
      </div>
      <p className="shrink-0 text-lg font-semibold tracking-tight text-foreground">{step.stores}</p>
    </li>
  );
}
