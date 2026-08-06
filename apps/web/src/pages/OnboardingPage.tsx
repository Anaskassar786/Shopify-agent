import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  CircleCheck,
  CreditCard,
  Database,
  Loader2,
  Moon,
  Settings as SettingsIcon,
  Sparkles,
  Store,
  Sun,
  Monitor,
  Zap,
} from "lucide-react";
import { Badge, Button, Card, CardBody, formatMoney, ProgressBar, Select, useTheme, useToast, type ThemeChoice } from "@profit/ui";
import { AutomationMode } from "@profit/types";
import { SyncManager } from "../components/SyncManager";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { daysUntil } from "../lib/format";
import {
  useCompleteOnboardingMutation,
  usePatchSettingsMutation,
  useStartTrialMutation,
  useStoreQuery,
  useSubscriptionQuery,
  useSyncStatusQuery,
} from "../lib/queries";

/**
 * Onboarding wizard (P4: install → connect → sync → configure → activate).
 * Standalone route (no shell chrome) reached from the layout gate whenever
 * settings.onboardingCompletedAt is null. Every step reads and writes REAL
 * state: the store row, the sync engine, store settings, the subscription —
 * completing the wizard is a persisted API call, not a UI trick.
 */

export const ONBOARDING_STEPS = ["Store connected", "Sync your data", "Preferences", "Activate trial"] as const;

/** Pure step-gating — unit tested; the wizard renders from its verdict. */
export interface OnboardingProgress {
  readonly step: number;
  readonly anySyncRunning: boolean;
  readonly allModulesSynced: boolean;
  readonly canEditSettings: boolean;
  readonly canManageBilling: boolean;
  readonly hasSubscription: boolean;
}

export function advanceBlockedReason(progress: OnboardingProgress): string | null {
  if (progress.step === 1 && progress.anySyncRunning) {
    return "A sync is running — wait for it to finish or come back in a minute.";
  }
  if (progress.step === 3 && !progress.hasSubscription && !progress.canManageBilling) {
    return "Only a user with billing permission can start the trial.";
  }
  return null;
}

function StepIndicator({ current }: { readonly current: number }): ReactNode {
  return (
    <ol className="flex items-center gap-2" aria-label="Onboarding progress">
      {ONBOARDING_STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} className="flex items-center gap-2">
            {index > 0 && <span className={`h-px w-5 sm:w-8 ${done || active ? "bg-primary" : "bg-subtle"}`} aria-hidden />}
            <span className="flex items-center gap-2">
              <span
                className={`flex size-7 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${
                  done
                    ? "bg-success text-on-primary"
                    : active
                      ? "bg-primary text-on-primary"
                      : "bg-surface-raised text-faint"
                }`}
                aria-current={active ? "step" : undefined}
              >
                {done ? <Check className="size-3.5" aria-hidden /> : index + 1}
              </span>
              <span className={`hidden text-xs font-medium sm:inline ${active ? "text-foreground" : "text-faint"}`}>
                {label}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ConnectedStep(): ReactNode {
  const store = useStoreQuery();
  const row = store.data?.store;
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-success-soft text-success">
        <CircleCheck className="size-6" aria-hidden />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">Your store is connected</h2>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">
          Shopify verified the install and granted scoped read access. From here on, everything you see is
          computed from your own data.
        </p>
      </div>
      {row !== undefined && (
        <dl className="grid w-full max-w-sm grid-cols-2 gap-3 rounded-lg border border-subtle bg-surface-raised/40 px-5 py-4 text-left">
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-faint">Store</dt>
            <dd className="mt-0.5 truncate text-sm font-medium text-foreground">{row.name}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-faint">Domain</dt>
            <dd className="mt-0.5 truncate text-sm text-foreground">{row.shopDomain}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-faint">Currency</dt>
            <dd className="mt-0.5 text-sm text-foreground">{row.currency}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-faint">Timezone</dt>
            <dd className="mt-0.5 truncate text-sm text-foreground">{row.timezone}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function SyncStep({ onRunningChange, allSynced }: { readonly onRunningChange?: boolean; readonly allSynced: boolean }): ReactNode {
  void onRunningChange;
  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">Pull in your data</h2>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">
          Start the full sync — products, customers, orders, inventory and more stream in from Shopify and the
          dashboard computes itself. You can continue while a partial sync catches up in the background.
        </p>
      </div>
      <SyncManager compact />
      {allSynced && (
        <p className="inline-flex items-center justify-center gap-1.5 text-xs font-medium text-success">
          <CircleCheck className="size-3.5" aria-hidden /> Every module has completed at least one sync.
        </p>
      )}
    </div>
  );
}

function PreferencesStep(): ReactNode {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const { choice, setChoice } = useTheme();
  const store = useStoreQuery();
  const patch = usePatchSettingsMutation();
  const canEdit = hasPermission("settings:update");
  const current = store.data?.settings?.aiPreferences ?? {};
  const [autonomy, setAutonomy] = useState<string>(() => {
    const mode = current["autonomyMode"];
    return typeof mode === "string" ? mode : AutomationMode.Manual;
  });
  const [saved, setSaved] = useState(false);

  const THEME_OPTIONS: ReadonlyArray<{ key: ThemeChoice; icon: ReactNode; label: string }> = [
    { key: "dark", icon: <Moon className="size-3.5" aria-hidden />, label: "Dark" },
    { key: "light", icon: <Sun className="size-3.5" aria-hidden />, label: "Light" },
    { key: "system", icon: <Monitor className="size-3.5" aria-hidden />, label: "System" },
  ];

  const onSave = (): void => {
    patch.mutate(
      { aiPreferences: { autonomyMode: autonomy } },
      {
        onSuccess: () => {
          setSaved(true);
          toast.success("Preferences saved", "The AI engine will respect your autonomy choice at activation.");
        },
        onError: (error: ApiError) => toast.error("Could not save preferences", error.message),
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">Make it yours</h2>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">
          Theme applies instantly. The autonomy mode is stored now and read by the AI engine the moment it
          activates on your store.
        </p>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium text-muted">Theme</p>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setChoice(option.key)}
              aria-pressed={choice === option.key}
              className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary ${
                choice === option.key
                  ? "border-primary bg-primary-soft text-foreground"
                  : "border-subtle text-muted hover:border-strong hover:text-foreground"
              }`}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="ob-autonomy" className="mb-2 block text-xs font-medium text-muted">
          AI autonomy mode
        </label>
        <Select id="ob-autonomy" value={autonomy} onChange={(event) => setAutonomy(event.target.value)} disabled={!canEdit}>
          <option value={AutomationMode.Manual}>Manual — approve every AI action</option>
          <option value={AutomationMode.SemiAutomatic}>Semi-automatic — auto-run low-risk actions</option>
          <option value={AutomationMode.FullyAutomatic}>Fully automatic — run inside guardrails</option>
        </Select>
        {!canEdit && (
          <p className="mt-1.5 text-[11px] text-faint">Your role can view but not change store settings.</p>
        )}
      </div>
      {canEdit && (
        <Button
          variant="secondary"
          size="sm"
          className="self-center"
          onClick={onSave}
          loading={patch.isPending}
          iconLeft={saved ? <Check className="size-3.5" aria-hidden /> : <SettingsIcon className="size-3.5" aria-hidden />}
        >
          {saved ? "Saved" : "Save preferences"}
        </Button>
      )}
    </div>
  );
}

function ActivateStep({ onActivated }: { readonly onActivated: () => void }): ReactNode {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const subscription = useSubscriptionQuery();
  const startTrial = useStartTrialMutation();
  const canManage = hasPermission("billing:manage");
  const sub = subscription.data?.subscription ?? null;
  const plan = subscription.data?.plan ?? null;
  const trialDaysLeft = daysUntil(sub?.trialEndsAt);

  const onStart = (): void => {
    startTrial.mutate(undefined, {
      onSuccess: () => {
        toast.success("Trial active", "Your free trial has started.");
        onActivated();
      },
      onError: (error: ApiError) => toast.error("Trial could not be started", error.message),
    });
  };

  if (subscription.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <span className="text-sm">Checking your subscription…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className={`flex size-12 items-center justify-center rounded-xl ${sub !== null ? "bg-success-soft text-success" : "bg-primary-soft text-primary"}`}>
        {sub !== null ? <CircleCheck className="size-6" aria-hidden /> : <CreditCard className="size-6" aria-hidden />}
      </div>
      {sub !== null && plan !== null ? (
        <>
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {sub.status === "TRIALING" ? "Your trial is running" : "Subscription ready"}
            </h2>
            <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">
              {sub.status === "TRIALING"
                ? `You are on the ${plan.name} trial (${formatMoney(plan.monthlyPriceCents, "USD")}/month after) — ${trialDaysLeft ?? "?"} of ${plan.trialDays} days left. Charges only happen if you approve them in Shopify.`
                : `Your ${plan.name} subscription is ${sub.status.toLowerCase()}.`}
            </p>
          </div>
          <Badge tone={sub.status === "TRIALING" ? "info" : sub.status === "ACTIVE" ? "success" : "warning"}>
            {sub.status.replaceAll("_", " ")}
          </Badge>
        </>
      ) : (
        <>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Activate your free trial</h2>
            <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">
              Full access starts with a free trial. No charge now — you approve any subscription in Shopify when
              the trial ends.
            </p>
          </div>
          {canManage ? (
            <Button onClick={onStart} loading={startTrial.isPending} iconLeft={<Zap className="size-4" aria-hidden />}>
              Start free trial
            </Button>
          ) : (
            <p className="text-xs text-faint">Ask a user with billing permission (owner/admin) to start the trial.</p>
          )}
        </>
      )}
    </div>
  );
}

export function OnboardingPage(): ReactNode {
  const navigate = useNavigate();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const [step, setStep] = useState(0);
  const [activated, setActivated] = useState(false);
  const sync = useSyncStatusQuery();
  const subscription = useSubscriptionQuery();
  const complete = useCompleteOnboardingMutation();

  const modules = sync.data?.modules ?? [];
  const anySyncRunning = modules.some((m) => m.status === "RUNNING");
  const allSynced = modules.length > 0 && modules.every((m) => m.status === "COMPLETED");
  const hasSubscription = subscription.data?.subscription != null || activated;

  const progress: OnboardingProgress = useMemo(
    () => ({
      step,
      anySyncRunning,
      allModulesSynced: allSynced,
      canEditSettings: hasPermission("settings:update"),
      canManageBilling: hasPermission("billing:manage"),
      hasSubscription,
    }),
    [step, anySyncRunning, allSynced, hasPermission, hasSubscription],
  );
  const blockedReason = advanceBlockedReason(progress);
  const lastStep = step === ONBOARDING_STEPS.length - 1;

  const onFinish = (): void => {
    complete.mutate(undefined, {
      onSuccess: () => {
        toast.success("You're all set", "Welcome to PROFIT TOOL AI — your dashboard is live.");
        navigate("/dashboard", { replace: true });
      },
      onError: (error: ApiError) => toast.error("Could not finish onboarding", error.message),
    });
  };

  return (
    <div className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col items-center gap-4">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-on-primary">
            <Sparkles className="size-5" aria-hidden />
          </div>
          <StepIndicator current={step} />
          <ProgressBar value={((step + 1) / ONBOARDING_STEPS.length) * 100} className="max-w-xs" label="Wizard progress" />
        </div>

        <Card>
          <CardBody className="px-5 py-8 sm:px-8">
            {step === 0 && <ConnectedStep />}
            {step === 1 && <SyncStep allSynced={allSynced} />}
            {step === 2 && <PreferencesStep />}
            {step === 3 && <ActivateStep onActivated={() => setActivated(true)} />}
          </CardBody>
        </Card>

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Back
          </Button>
          {blockedReason !== null && <p className="mx-3 text-center text-[11px] text-warning">{blockedReason}</p>}
          {lastStep ? (
            <Button
              onClick={onFinish}
              loading={complete.isPending}
              disabled={!hasPermission("settings:update") || blockedReason !== null}
              iconRight={<Store className="size-4" aria-hidden />}
            >
              Enter your dashboard
            </Button>
          ) : (
            <Button
              onClick={() => setStep((s) => Math.min(ONBOARDING_STEPS.length - 1, s + 1))}
              disabled={blockedReason !== null}
              iconRight={<Database className="size-4" aria-hidden />}
            >
              Continue
            </Button>
          )}
        </div>
        {lastStep && !hasPermission("settings:update") && (
          <p className="text-center text-[11px] text-faint">
            Finishing setup writes a store setting — ask an owner or admin to complete this step.
          </p>
        )}
      </div>
    </div>
  );
}
