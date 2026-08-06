import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Cpu, Gauge as GaugeIcon, Sparkles } from "lucide-react";
import {
  AnimatedNumber,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Gauge,
  SkeletonText,
  StatCard,
  useToast,
  formatMoney,
} from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatRelativeTime } from "../lib/format";
import { useAiOverviewQuery, useRunAnalysisMutation } from "../lib/queries";
import type { AiOverviewResponse } from "../lib/api-types";
import { formatCostMicros, RECOMMENDATION_EVENT_LABEL, recommendationTypeLabel } from "./ai-shared";

const RUN_STATUS_TONE: Readonly<Record<string, "success" | "warning" | "danger" | "neutral">> = {
  COMPLETED: "success",
  PROVIDER_UNAVAILABLE: "warning",
  FAILED: "danger",
};

function RunAnalysisButton(): ReactNode {
  const { hasPermission } = useAuth();
  const run = useRunAnalysisMutation();
  const toast = useToast();
  if (!hasPermission("recommendations:approve")) return null;
  return (
    <Button
      size="sm"
      iconLeft={<Sparkles className="size-3.5" aria-hidden />}
      loading={run.isPending}
      onClick={() =>
        run.mutate(undefined, {
          onSuccess: () => toast.success("Analysis is running", "Fresh decisions stream into the feed below the moment they land."),
          onError: (error: ApiError) => toast.error("Analysis could not start", error.message),
        })
      }
    >
      Run analysis now
    </Button>
  );
}

function FirstRunHero(): ReactNode {
  const { hasPermission } = useAuth();
  const run = useRunAnalysisMutation();
  const toast = useToast();
  return (
    <Card>
      <EmptyState
        icon={<Sparkles className="size-6" aria-hidden />}
        title="No analysis has run yet"
        body="This is where the AI engine reports in: every run reads your synced store data, proposes revenue actions with evidence, and waits for your approval. It never acts on its own unless you enable automation."
        primaryAction={
          hasPermission("recommendations:approve") ? (
            <Button
              size="sm"
              onClick={() =>
                run.mutate(undefined, {
                  onSuccess: () => toast.success("Analysis is running", "The first recommendations land here within moments."),
                  onError: (error: ApiError) => toast.error("Analysis could not start", error.message),
                })
              }
              loading={run.isPending}
            >
              Run your first analysis
            </Button>
          ) : undefined
        }
      />
    </Card>
  );
}

function DecisionFeed({ events }: { readonly events: AiOverviewResponse["recentEvents"] }): ReactNode {
  return (
    <Card>
      <CardHeader
        title="Decision feed"
        subtitle="Every engine decision, newest first — the append-only record"
        actions={
          <Link
            to="/recommendations"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-strong"
          >
            All recommendations <ArrowRight className="size-3" aria-hidden />
          </Link>
        }
      />
      <CardBody>
        {events.length === 0 ? (
          <p className="py-2 text-sm text-muted">No decisions recorded yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-subtle" aria-label="Recent decisions">
            {events.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <Link
                    to={`/recommendations/${event.recommendationId}`}
                    className="block truncate text-sm font-medium text-foreground transition-colors hover:text-primary"
                  >
                    {event.title}
                  </Link>
                  <p className="text-[11px] text-faint">
                    {recommendationTypeLabel(event.type)} · {event.actorType === "AI" ? "AI engine" : event.actorType === "MERCHANT" ? "merchant" : "system"} · {formatRelativeTime(event.createdAt)}
                  </p>
                </div>
                <Badge tone={event.event === "EXECUTED" || event.event === "MEASURED" ? "success" : event.event === "APPROVED" || event.event === "AUTO_APPROVED" ? "info" : "neutral"}>
                  {RECOMMENDATION_EVENT_LABEL[event.event] ?? recommendationTypeLabel(event.event)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export function AiCommandCenterPage(): ReactNode {
  const overview = useAiOverviewQuery();
  const data = overview.data;

  return (
    <div>
      <PageHeader
        title="AI Command Center"
        subtitle="The engine's control room: run state, store health, every decision it proposed, and the revenue it actually recovered."
        actions={<RunAnalysisButton />}
      />

      <QueryBoundary query={overview} loading={<SkeletonText lines={6} />}>
        {data?.engine.lastRunAt === null || data === undefined ? (
          <FirstRunHero />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Engine status"
                icon={<Cpu className="size-4" aria-hidden />}
                value={
                  <Badge tone={RUN_STATUS_TONE[data.engine.lastRunStatus ?? "COMPLETED"] ?? "neutral"}>
                    {data.engine.lastRunStatus ?? "—"}
                  </Badge>
                }
                hint={`${data.engine.lastRunTrigger?.toLowerCase() ?? ""} run · ${formatRelativeTime(data.engine.lastRunAt)} · ${String(data.engine.runsLast7d)} runs / 7d`}
              />
              <StatCard
                label="Compute cost (7d)"
                value={formatCostMicros(data.engine.costMicrosLast7d)}
                hint={`${data.engine.tokensLast7d.toLocaleString("en-US")} tokens`}
              />
              <StatCard
                label="Awaiting decision"
                value={<AnimatedNumber value={data.open.pendingApproval} />}
                hint={data.open.highPriorityOpen > 0 ? `${String(data.open.highPriorityOpen)} high priority` : "queue is calm"}
              />
              <StatCard
                label="Recovered by actions"
                value={formatMoney(data.outcomes.attributedRevenueCents)}
                hint={`${String(data.outcomes.attributedOrders)} orders linked with deterministic matching`}
              />
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-3">
              <Card className="xl:col-span-1">
                <CardHeader title="Store health" subtitle="Deterministic score from your synced data — never model-written" />
                <CardBody className="flex flex-col items-center gap-4">
                  {data.health.score !== null ? (
                    <Gauge
                      value={data.health.score}
                      label="Health score"
                      tone={data.health.score >= 70 ? "success" : data.health.score >= 40 ? "warning" : "danger"}
                      size={132}
                    />
                  ) : (
                    <p className="py-6 text-sm text-muted">Score lands with the first completed run.</p>
                  )}
                  {data.health.components !== null && (
                    <ul className="w-full flex-col gap-2 divide-y divide-subtle" aria-label="Health components">
                      {data.health.components.components.map((component) => (
                        <li key={component.key} className="w-full py-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-foreground">{component.label}</p>
                            <span className="tabular-nums text-xs font-semibold text-muted">{component.score}</span>
                          </div>
                          <p className="mt-0.5 text-[11px] leading-snug text-faint">{component.reason}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>

              <div className="flex flex-col gap-4 xl:col-span-2">
                <Card>
                  <CardHeader title="Pipeline" subtitle="Where every recommendation stands right now" />
                  <CardBody>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-lg border border-subtle bg-surface-raised p-3 text-center">
                        <p className="text-2xl font-semibold tabular-nums text-foreground">
                          <AnimatedNumber value={data.open.pendingApproval} />
                        </p>
                        <p className="mt-1 text-xs text-muted">Awaiting decision</p>
                      </div>
                      <div className="rounded-lg border border-subtle bg-surface-raised p-3 text-center">
                        <p className="text-2xl font-semibold tabular-nums text-foreground">
                          <AnimatedNumber value={data.open.approved} />
                        </p>
                        <p className="mt-1 text-xs text-muted">Approved to run</p>
                      </div>
                      <div className="rounded-lg border border-subtle bg-surface-raised p-3 text-center">
                        <p className="text-2xl font-semibold tabular-nums text-foreground">
                          <AnimatedNumber value={data.open.executing} />
                        </p>
                        <p className="mt-1 text-xs text-muted">Executing now</p>
                      </div>
                    </div>
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader
                    title="Learning loop"
                    subtitle="The engine re-calibrates from your decisions (P12 acceptance loop)"
                    actions={<GaugeIcon className="size-4 text-faint" aria-hidden />}
                  />
                  <CardBody>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-lg border border-subtle bg-surface-raised p-3 text-center">
                        <p className="text-2xl font-semibold tabular-nums text-foreground">
                          {data.outcomes.acceptanceRatePct !== null ? `${String(data.outcomes.acceptanceRatePct)}%` : "—"}
                        </p>
                        <p className="mt-1 text-xs text-muted">Acceptance rate</p>
                      </div>
                      <div className="rounded-lg border border-subtle bg-surface-raised p-3 text-center">
                        <p className="text-2xl font-semibold tabular-nums text-foreground">
                          {data.outcomes.attributedOrders}
                        </p>
                        <p className="mt-1 text-xs text-muted">Recovered orders</p>
                      </div>
                      <div className="rounded-lg border border-subtle bg-surface-raised p-3 text-center">
                        <p className="text-2xl font-semibold tabular-nums text-foreground">
                          {formatMoney(data.outcomes.attributedRevenueCents)}
                        </p>
                        <p className="mt-1 text-xs text-muted">Revenue attributed</p>
                      </div>
                    </div>
                  </CardBody>
                </Card>

                <DecisionFeed events={data.recentEvents} />
              </div>
            </div>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
