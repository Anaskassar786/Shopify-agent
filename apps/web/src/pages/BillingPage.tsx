import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  BadgeCheck,
  CalendarDays,
  Check,
  CreditCard,
  Gauge as GaugeIcon,
  History,
  Sparkles,
  TrendingUp,
  Zap,
} from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, Select, formatMoney, ProgressBar, useToast } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { daysUntil, formatDateTime } from "../lib/format";
import { useStartTrialMutation } from "../lib/queries";
import { useStoreQuery } from "../lib/queries";
import {
  useBillingHistoryQuery,
  useBillingOverviewQuery,
  useBillingPlansQuery,
  useCancelSubscriptionMutation,
  useEmitEngagementEventMutation,
  useRoiReportQuery,
  useSubscribeMutation,
  type SubscribeInput,
} from "../lib/billing-queries";
import type { BillingEventRow, BillingIntervalValue, PlanRow, UsageMeterRow } from "../lib/api-types";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  TRIALING: "info",
  ACTIVE: "success",
  CHARGE_PENDING: "warning",
  TRIAL_EXPIRED: "warning",
  PAST_DUE: "danger",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  SUSPENDED: "danger",
};

const METER_LABEL: Record<UsageMeterRow["meter"], string> = {
  AI_CALLS: "AI calls",
  EMAILS_SENT: "Emails sent",
  SMS_SENT: "SMS sent",
  AUTOMATION_RUNS: "Automation runs",
};

const EVENT_LABEL: Record<string, string> = {
  TRIAL_STARTED: "Trial started",
  TRIAL_NUDGE_SENT: "Trial reminder sent",
  TRIAL_EXPIRED: "Trial ended",
  CHARGE_CREATED: "Charge created in Shopify",
  CHARGE_ACCEPTED: "Charge approved",
  CHARGE_DECLINED: "Charge not completed",
  CHARGE_CANCELLED: "Subscription cancelled in Shopify",
  CHARGE_RECONCILED: "Billing synchronized with Shopify",
  PLAN_CHANGED: "Plan changed",
  SUBSCRIPTION_SUSPENDED: "Subscription suspended",
  SUBSCRIPTION_REACTIVATED: "Subscription reactivated",
};

/** Return states set by the charge callback bounce (?billing_state=…). */
const RETURN_STATE_TOAST = {
  activated: {
    tone: "success",
    title: "Subscription active",
    body: "Your paid plan is confirmed. Automation and AI measurement continue without interruption.",
  },
  pending: {
    tone: "info",
    title: "Approval still pending",
    body: "Shopify has not confirmed the charge yet — this page updates as soon as it does.",
  },
  declined: {
    tone: "warning",
    title: "Charge was not completed",
    body: "No payment was taken. Start your trial again or pick a plan whenever you are ready.",
  },
} as const;

function billingStateParam(search: URLSearchParams): keyof typeof RETURN_STATE_TOAST | null {
  const raw = search.get("billing_state");
  return raw !== null && raw in RETURN_STATE_TOAST ? (raw as keyof typeof RETURN_STATE_TOAST) : null;
}

function fallbackEntitlements(): PlanRow["entitlements"] {
  return {
    capabilities: [],
    quotas: { aiCalls: 0, emails: 0, sms: 0, automationRuns: 0, seats: 0, stores: 0 },
  };
}

export function BillingPage(): ReactNode {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const overview = useBillingOverviewQuery();
  const plans = useBillingPlansQuery();
  const history = useBillingHistoryQuery();
  const roi = useRoiReportQuery(30);
  const store = useStoreQuery();
  const startTrial = useStartTrialMutation();
  const subscribe = useSubscribeMutation();
  const cancel = useCancelSubscriptionMutation();
  const emitEngagement = useEmitEngagementEventMutation();

  const canManage = hasPermission("billing:manage");
  const [startTrialOpen, setStartTrialOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<SubscribeInput | null>(null);
  const [interval, setInterval] = useState<BillingIntervalValue>("MONTHLY");

  const sub = overview.data?.subscription ?? null;
  const plan = overview.data?.plan ?? null;
  const usage = overview.data?.usage ?? null;
  const access = overview.data?.access ?? null;
  const trialDaysLeft = daysUntil(sub?.trialEndsAt ?? null);
  const isSubscribed = sub !== null && plan !== null;
  const shopDomain = store.data?.store.shopDomain ?? null;

  // Funnel telemetry: viewing Billing IS the upgrade-consideration signal.
  useEffect(() => {
    emitEngagement.mutate({ kind: "UPGRADE_VIEWED" }, { onError: () => undefined });
    // Mounted once per visit — the server dedupes/persists by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Post-callback bounce: surface the outcome once, then strip the param.
  useEffect(() => {
    const state = billingStateParam(searchParams);
    if (state === null) return;
    const copy = RETURN_STATE_TOAST[state];
    if (copy.tone === "success") toast.success(copy.title, copy.body);
    else if (copy.tone === "info") toast.info(copy.title, copy.body);
    else toast.error(copy.title, copy.body);
    searchParams.delete("billing_state");
    setSearchParams(searchParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams, toast]);

  const onStartTrial = (): void => {
    setStartTrialOpen(false);
    startTrial.mutate(undefined, {
      onSuccess: () => toast.success("Trial started", "Your free trial is now active — enjoy the full product."),
      onError: (error: ApiError) => toast.error("Trial could not be started", error.message),
    });
  };

  const onSubscribe = (): void => {
    if (pendingPlan === null) return;
    const input = pendingPlan;
    setPendingPlan(null);
    subscribe.mutate(input, {
      onSuccess: (result) => {
        // Shopify's decision screen REFUSES iframe rendering — the redirect
        // must break out to the top window (billing-callback bounces back in).
        window.open(result.confirmationUrl, "_top");
      },
      onError: (error: ApiError) => toast.error("Subscription could not start", error.message),
    });
  };

  const onCancel = (): void => {
    setCancelOpen(false);
    cancel.mutate(undefined, {
      onSuccess: () => toast.success("Subscription cancelled", "Your plan ends at the close of the current period."),
      onError: (error: ApiError) => toast.error("Cancellation failed", error.message),
    });
  };

  const hasPlanCards = (plans.data?.plans.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Billing"
        subtitle="Plans, quotas and your Shopify charge — every payment is handled by Shopify, never by us."
        actions={
          canManage && isSubscribed && sub.status !== "CANCELLED" && sub.status !== "SUSPENDED" ? (
            <>
              {shopDomain !== null && (
                <a
                  href={`https://${shopDomain}/admin/settings/billing`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 select-none items-center justify-center gap-2 rounded-md px-4 text-sm font-medium text-muted transition-all duration-[var(--transition-fast)] hover:bg-surface-raised hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  Invoices in Shopify
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </a>
              )}
              {sub.status === "ACTIVE" || sub.status === "PAST_DUE" ? (
                <Button variant="danger" onClick={() => setCancelOpen(true)}>
                  Cancel plan
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      {access !== null && !access.revenueActionsAllowed && isSubscribed && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm leading-relaxed text-foreground" role="alert">
          {access.blockedReason ?? "Revenue actions are currently paused for this plan."}
        </div>
      )}

      {/* Plan state + trial banner */}
      {!isSubscribed ? (
        <Card>
          <CardBody className="flex flex-col items-center gap-4 py-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-lg bg-primary-soft text-primary">
              <Sparkles className="size-6" aria-hidden />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Start your free trial</h2>
              <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">
                Every plan begins with a free trial — full access, no charge until you approve the
                subscription in Shopify. Pick a plan below or start on the recommended one.
              </p>
            </div>
            {canManage ? (
              <Button
                onClick={() => setStartTrialOpen(true)}
                loading={startTrial.isPending}
                iconLeft={<Zap className="size-4" aria-hidden />}
              >
                Start free trial
              </Button>
            ) : (
              <p className="text-xs text-faint">Only users with billing permission can start the trial.</p>
            )}
            {plans.isError && (
              <p className="text-xs text-danger">Plans could not be loaded — retry in a moment.</p>
            )}
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  {plan.name} plan{" "}
                  <Badge tone={STATUS_TONE[sub.status] ?? "neutral"}>{sub.status.replaceAll("_", " ")}</Badge>
                </span>
              }
              subtitle={plan.description ?? "Subscription plan"}
            />
            <CardBody>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-3xl font-semibold tracking-tight text-foreground">
                    {formatMoney(plan.monthlyPriceCents, "USD")}
                    <span className="text-sm font-normal text-muted">/month</span>
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    or {formatMoney(plan.yearlyPriceCents, "USD")}/year · {plan.trialDays}-day free trial included
                  </p>
                </div>
                <div className="rounded-lg border border-subtle bg-surface-raised/40 px-4 py-3 text-right">
                  <p className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                    <CalendarDays className="size-3.5" aria-hidden />
                    {sub.status === "TRIALING" ? "Trial ends" : "Current period ends"}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {formatDateTime(sub.status === "TRIALING" ? sub.trialEndsAt : sub.currentPeriodEnd)}
                  </p>
                </div>
              </div>
              {sub.status === "TRIALING" && trialDaysLeft !== null && (
                <div className="mt-5">
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="text-muted">Trial progress</span>
                    <span className="font-medium text-foreground">
                      {trialDaysLeft} of {plan.trialDays} days left
                    </span>
                  </div>
                  <ProgressBar
                    value={plan.trialDays === 0 ? 0 : ((plan.trialDays - trialDaysLeft) / plan.trialDays) * 100}
                    tone={trialDaysLeft <= 1 ? "warning" : "primary"}
                    label="Trial elapsed"
                  />
                </div>
              )}
              {(sub.status === "TRIALING" || sub.status === "TRIAL_EXPIRED" || sub.status === "CHARGE_PENDING") && (
                <div className="mt-5 flex flex-wrap items-center gap-3 rounded-md bg-primary-soft px-3.5 py-2.5">
                  <BadgeCheck className="size-4 shrink-0 text-primary" aria-hidden />
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">
                    {sub.status === "CHARGE_PENDING"
                      ? "Your Shopify charge is awaiting approval — finish it in Shopify to activate the plan."
                      : sub.status === "TRIAL_EXPIRED"
                        ? "Your trial has ended. Choose a plan below to keep revenue actions running — your data and settings are preserved."
                        : "Approve a plan now to roll your remaining trial days into the paid period — nothing is charged twice."}
                  </p>
                </div>
              )}
              {sub.status === "PAST_DUE" && (
                <p className="mt-5 rounded-md bg-danger-soft px-3.5 py-2.5 text-xs leading-relaxed text-danger">
                  The latest charge did not go through. Update your payment method in Shopify Admin to avoid
                  interruption; the grace period keeps the app running meanwhile.
                </p>
              )}
            </CardBody>
          </Card>

          {/* Usage meters — the quota story of this plan window */}
          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <GaugeIcon className="size-4 text-primary" aria-hidden /> Usage this period
                </span>
              }
              subtitle={usage !== null ? formatDateTime(usage.window.from) : undefined}
            />
            <CardBody className="flex flex-col gap-4">
              <QueryBoundary query={overview} compact>
                {usage === null || usage.entitlements === null ? (
                  <p className="text-sm text-muted">Usage metering starts once a plan is active.</p>
                ) : (
                  usage.meters.map((meter) => (
                    <div key={meter.meter}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="text-muted">{METER_LABEL[meter.meter]}</span>
                        <span className="font-medium text-foreground">
                          {meter.percentUsed === null
                            ? `${meter.used} used`
                            : `${meter.used} of ${meter.limit}`}
                        </span>
                      </div>
                      <ProgressBar
                        value={meter.percentUsed ?? 0}
                        tone={
                          meter.percentUsed !== null && meter.percentUsed >= 90
                            ? "danger"
                            : meter.percentUsed !== null && meter.percentUsed >= 70
                              ? "warning"
                              : "primary"
                        }
                        label={METER_LABEL[meter.meter]}
                      />
                    </div>
                  ))
                )}
              </QueryBoundary>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Plan comparison — upgrades AND the only path to leave TRIAL_EXPIRED */}
      <Card>
        <CardHeader
          title="Plans"
          subtitle="Choose how PROFIT TOOL AI scales with your store. Billing runs through Shopify's own checkout."
          actions={
            <Select
              aria-label="Billing interval"
              value={interval}
              onChange={(event) => setInterval(event.target.value as BillingIntervalValue)}
            >
              <option value="MONTHLY">Monthly billing</option>
              <option value="YEARLY">Yearly billing — 2 months free</option>
            </Select>
          }
        />
        <CardBody>
          <QueryBoundary query={plans} compact>
            {!hasPlanCards ? (
              <p className="py-6 text-center text-sm text-muted">
                {plans.isError ? "Plans could not be loaded." : "The plan catalog is being prepared."}
              </p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {plans.data!.plans.map((candidate) => (
                  <PlanCard
                    key={candidate.id}
                    plan={candidate}
                    interval={interval}
                    isCurrent={plans.data!.currentPlanId === candidate.id}
                    canManage={canManage}
                    subscribing={subscribe.isPending}
                    onChoose={(planCode) =>
                      canManage
                        ? setPendingPlan({ planCode, interval })
                        : toast.info("Insufficient permission", "Ask a store owner to manage billing.")
                    }
                  />
                ))}
              </div>
            )}
          </QueryBoundary>
        </CardBody>
      </Card>

      {/* ROI — the honest value ledger */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <TrendingUp className="size-4 text-ai" aria-hidden /> What the AI has returned
            </span>
          }
          subtitle="Measured attribution against metered AI cost over the last 30 days — modeled where measurement is impossible, always labeled."
        />
        <CardBody>
          <QueryBoundary query={roi} compact>
            {roi.data === undefined ? (
              <p className="py-4 text-sm text-muted">ROI reporting is not available yet.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <RoiStat
                  label="Return multiple"
                  value={roi.data.roiMultiple === null ? "—" : `${roi.data.roiMultiple.toFixed(1)}×`}
                  hint={
                    roi.data.roiMultiple === null
                      ? "No AI cost recorded yet"
                      : "attributed revenue ÷ AI cost"
                  }
                />
                <RoiStat
                  label="Attributed revenue"
                  value={formatMoney(roi.data.outcomes.attributedRevenueCents, "USD")}
                  hint={`${roi.data.outcomes.measuredRecommendations} measured conversion${
                    roi.data.outcomes.measuredRecommendations === 1 ? "" : "s"
                  }`}
                />
                <RoiStat
                  label="AI cost"
                  value={formatMoney(Math.round(roi.data.cost.micros / 10_000), "USD")}
                  hint={`${roi.data.cost.calls} model call${roi.data.cost.calls === 1 ? "" : "s"}`}
                />
                <RoiStat
                  label="Open pipeline"
                  value={formatMoney(roi.data.pipeline.openEstimatedRevenueCents, "USD")}
                  hint={`${roi.data.pipeline.openRecommendations} open opportunities (modeled)`}
                />
              </div>
            )}
          </QueryBoundary>
        </CardBody>
      </Card>

      {/* Ledger — billing history feed */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <History className="size-4 text-muted" aria-hidden /> Billing history
            </span>
          }
          subtitle="Every subscription event, in order — the same ledger our support team sees."
        />
        <CardBody>
          <QueryBoundary query={history} compact>
            {(history.data ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">
                No billing events yet — they appear here from your first trial step onward.
              </p>
            ) : (
              <ol className="relative ml-2 flex flex-col gap-4 border-l border-subtle pl-5">
                {(history.data ?? []).map((event) => (
                  <BillingEventItem key={event.id} event={event} />
                ))}
              </ol>
            )}
          </QueryBoundary>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={startTrialOpen}
        onClose={() => setStartTrialOpen(false)}
        onConfirm={onStartTrial}
        title="Start your free trial?"
        body="This activates a trial subscription on the recommended plan. You will only be charged if you approve the subscription in Shopify after the trial ends — starting the trial itself is free."
        confirmLabel="Start trial"
      />
      <ConfirmDialog
        open={pendingPlan !== null}
        onClose={() => setPendingPlan(null)}
        onConfirm={onSubscribe}
        title="Continue to Shopify checkout?"
        body={`You'll review and approve the ${
          pendingPlan !== null
            ? `${formatMoney(
                (plans.data?.plans.find((p) => p.code === pendingPlan.planCode)?.[
                  pendingPlan.interval === "MONTHLY" ? "monthlyPriceCents" : "yearlyPriceCents"
                ] ?? 0),
                "USD",
              )} ${pendingPlan.interval === "MONTHLY" ? "monthly" : "yearly"}`
            : ""
        } charge inside Shopify. Remaining trial days are preserved and roll into your first paid period.`}
        confirmLabel="Continue to Shopify"
      />
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={onCancel}
        title="Cancel the subscription?"
        body="The plan stays active until the end of the current paid period, then revenue actions pause. Your data, settings and history are preserved. You can resubscribe any time from this page."
        confirmLabel="Cancel plan"
        danger
      />
    </div>
  );
}

function PlanCard({
  plan,
  interval,
  isCurrent,
  canManage,
  subscribing,
  onChoose,
}: {
  readonly plan: PlanRow;
  readonly interval: BillingIntervalValue;
  readonly isCurrent: boolean;
  readonly canManage: boolean;
  readonly subscribing: boolean;
  readonly onChoose: (planCode: string) => void;
}): ReactNode {
  const entitlements = plan.entitlements ?? fallbackEntitlements();
  const priceCents = interval === "MONTHLY" ? plan.monthlyPriceCents : plan.yearlyPriceCents;
  const topQuotas: readonly (readonly [string, number])[] = (
    [
      ["AI calls", entitlements.quotas.aiCalls],
      ["Emails", entitlements.quotas.emails],
      ["Automation runs", entitlements.quotas.automationRuns],
    ] as const
  ).filter((entry) => entry[1] > 0);
  return (
    <div
      className={
        isCurrent
          ? "flex flex-col gap-3 rounded-lg border-2 border-primary/60 bg-primary-soft/30 p-4"
          : "flex flex-col gap-3 rounded-lg border border-subtle bg-surface-raised/30 p-4"
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">{plan.name}</p>
          <p className="mt-0.5 text-xs text-muted">{plan.description ?? "Subscription plan"}</p>
        </div>
        {isCurrent && <Badge tone="success">Current</Badge>}
      </div>
      <p className="text-xl font-semibold tracking-tight text-foreground">
        {formatMoney(priceCents, "USD")}
        <span className="text-xs font-normal text-muted">/{interval === "MONTHLY" ? "mo" : "yr"}</span>
      </p>
      <ul className="flex flex-col gap-1.5 text-xs text-muted">
        {topQuotas.map(([label, value]) => (
          <li key={label} className="flex items-center gap-1.5">
            <Check className="size-3.5 shrink-0 text-success" aria-hidden />
            {value} {label}/period
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <Check className="size-3.5 shrink-0 text-success" aria-hidden />
          {plan.trialDays}-day free trial
        </li>
      </ul>
      <div className="mt-auto pt-2">
        {isCurrent ? (
          <Button variant="ghost" disabled className="w-full">
            Your plan
          </Button>
        ) : (
          <Button
            variant={canManage ? "primary" : "ghost"}
            className="w-full"
            loading={subscribing}
            onClick={() => onChoose(plan.code)}
          >
            Choose {plan.name}
          </Button>
        )}
      </div>
    </div>
  );
}

function RoiStat({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint: string }): ReactNode {
  return (
    <div className="rounded-lg border border-subtle bg-surface-raised/30 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-faint">{hint}</p>
    </div>
  );
}

function BillingEventItem({ event }: { readonly event: BillingEventRow }): ReactNode {
  const label = EVENT_LABEL[event.type] ?? event.type.replaceAll("_", " ");
  const amount =
    event.amountCents !== null
      ? ` · ${formatMoney(event.amountCents, "USD")}${event.interval === "YEARLY" ? "/yr" : event.interval === "MONTHLY" ? "/mo" : ""}`
      : "";
  return (
    <li className="relative">
      <span
        className="absolute -left-[26px] top-1 size-2.5 rounded-full bg-primary"
        aria-hidden
      />
      <p className="text-sm text-foreground">
        {label}
        <span className="text-muted">{amount}</span>
      </p>
      <p className="mt-0.5 text-xs text-faint">{formatDateTime(event.createdAt)}</p>
    </li>
  );
}
