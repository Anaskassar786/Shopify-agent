import { useState, type ReactNode } from "react";
import { CalendarDays, CreditCard, Sparkles, Zap } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, formatMoney, ProgressBar, useToast } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { daysUntil, formatDateTime } from "../lib/format";
import { useStartTrialMutation, useSubscriptionQuery } from "../lib/queries";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  TRIALING: "info",
  ACTIVE: "success",
  TRIAL_EXPIRED: "warning",
  PAST_DUE: "danger",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  SUSPENDED: "danger",
};

export function BillingPage(): ReactNode {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const subscription = useSubscriptionQuery();
  const startTrial = useStartTrialMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canManage = hasPermission("billing:manage");

  const sub = subscription.data?.subscription ?? null;
  const plan = subscription.data?.plan ?? null;
  const trialDaysLeft = daysUntil(sub?.trialEndsAt);

  const onStartTrial = (): void => {
    setConfirmOpen(false);
    startTrial.mutate(undefined, {
      onSuccess: () => toast.success("Trial started", "Your free trial is now active — enjoy the full product."),
      onError: (error: ApiError) => toast.error("Trial could not be started", error.message),
    });
  };

  return (
    <div>
      <PageHeader
        title="Billing"
        subtitle="Your plan and subscription state, as recorded by the platform. Charges are handled by Shopify."
      />
      <QueryBoundary query={subscription}>
        {sub === null || plan === null ? (
          <Card>
            <CardBody className="flex flex-col items-center gap-4 py-10 text-center">
              <div className="flex size-12 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Sparkles className="size-6" aria-hidden />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Start your free trial</h2>
                <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">
                  Every plan begins with a free trial — full access, no charge until the trial ends and you
                  approve the subscription in Shopify.
                </p>
              </div>
              {canManage ? (
                <Button onClick={() => setConfirmOpen(true)} loading={startTrial.isPending} iconLeft={<Zap className="size-4" aria-hidden />}>
                  Start free trial
                </Button>
              ) : (
                <p className="text-xs text-faint">Only users with billing permission can start the trial.</p>
              )}
            </CardBody>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title={
                  <span className="inline-flex items-center gap-2">
                    {plan.name} plan <Badge tone={STATUS_TONE[sub.status] ?? "neutral"}>{sub.status.replaceAll("_", " ")}</Badge>
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
                {sub.status === "TRIAL_EXPIRED" && (
                  <p className="mt-5 rounded-md bg-warning-soft px-3.5 py-2.5 text-xs leading-relaxed text-warning">
                    Your trial has ended. Approve the subscription charge in Shopify Admin → Apps → PROFIT TOOL AI
                    to keep full access — your data and settings are preserved.
                  </p>
                )}
                {sub.status === "PAST_DUE" && (
                  <p className="mt-5 rounded-md bg-danger-soft px-3.5 py-2.5 text-xs leading-relaxed text-danger">
                    The latest charge did not go through. Update your payment method in Shopify Admin to avoid
                    interruption; the grace period keeps the app running meanwhile.
                  </p>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="How billing works" />
              <CardBody className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted">
                <p className="flex gap-2.5">
                  <CreditCard className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  All charges are processed by Shopify's own billing — the platform never sees your card details.
                </p>
                <p className="flex gap-2.5">
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-ai" aria-hidden />
                  Upgrading, downgrading or cancelling happens from Shopify Admin → Apps → PROFIT TOOL AI and
                  takes effect immediately on this page.
                </p>
                <p className="flex gap-2.5">
                  <CalendarDays className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
                  Trial reminders arrive before the trial ends so there are no surprises.
                </p>
              </CardBody>
            </Card>
          </div>
        )}
      </QueryBoundary>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={onStartTrial}
        title="Start your free trial?"
        body="This activates a trial subscription on the default plan. You will only be charged if you approve the subscription in Shopify after the trial ends — starting the trial itself is free."
        confirmLabel="Start trial"
      />
    </div>
  );
}
