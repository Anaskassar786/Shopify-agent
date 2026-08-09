import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Clock, Mail, MapPin, Monitor, Moon, Store, Sun } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Input, Select, Tabs, useToast, useTheme, type ThemeChoice } from "@profit/ui";
import { AutomationMode } from "@profit/types";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { SyncManager } from "../components/SyncManager";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatDateTime } from "../lib/format";
import { usePatchSettingsMutation, useStoreQuery } from "../lib/queries";

const TABS = [
  { key: "general", label: "Store" },
  { key: "appearance", label: "Appearance" },
  { key: "branding", label: "Branding & AI" },
  { key: "sync", label: "Sync" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isTabKey(value: string | null): value is TabKey {
  return TABS.some((tab) => tab.key === value);
}

const THEME_CARDS: ReadonlyArray<{ key: ThemeChoice; label: string; body: string; icon: ReactNode }> = [
  { key: "dark", label: "Dark", body: "Default — tuned for long sessions", icon: <Moon className="size-4" aria-hidden /> },
  { key: "light", label: "Light", body: "High-brightness workspaces", icon: <Sun className="size-4" aria-hidden /> },
  { key: "system", label: "System", body: "Follows your OS setting", icon: <Monitor className="size-4" aria-hidden /> },
];

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function GeneralTab(): ReactNode {
  const store = useStoreQuery();
  return (
    <Card>
      <CardHeader title="Store profile" subtitle="As synced from Shopify — read-only here; edits happen in Shopify Admin." />
      <CardBody>
        <QueryBoundary query={store}>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <dt className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint"><Store className="size-3.5" aria-hidden /> Store</dt>
              <dd className="mt-1 text-sm font-medium text-foreground">{store.data?.store.name}</dd>
              <dd className="text-xs text-muted">{store.data?.store.shopDomain}</dd>
            </div>
            <div>
              <dt className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint"><Mail className="size-3.5" aria-hidden /> Contact email</dt>
              <dd className="mt-1 text-sm text-foreground">{store.data?.store.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-faint">Currency</dt>
              <dd className="mt-1 text-sm text-foreground">{store.data?.store.currency}</dd>
            </div>
            <div>
              <dt className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint"><Clock className="size-3.5" aria-hidden /> Timezone</dt>
              <dd className="mt-1 text-sm text-foreground">{store.data?.store.timezone}</dd>
            </div>
            <div>
              <dt className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint"><MapPin className="size-3.5" aria-hidden /> Installed</dt>
              <dd className="mt-1 text-sm text-foreground">{formatDateTime(store.data?.store.installedAt)}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-faint">Onboarding</dt>
              <dd className="mt-1 text-sm text-foreground">
                {store.data?.settings?.onboardingCompletedAt != null
                  ? `Completed ${formatDateTime(store.data.settings.onboardingCompletedAt)}`
                  : "Not completed"}
              </dd>
            </div>
          </dl>
        </QueryBoundary>
      </CardBody>
    </Card>
  );
}

function AppearanceTab(): ReactNode {
  const { choice, setChoice } = useTheme();
  return (
    <Card>
      <CardHeader title="Theme" subtitle="Applies instantly and is remembered on this device. Dark is the designed default." />
      <CardBody>
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
          {THEME_CARDS.map((card) => {
            const selected = choice === card.key;
            return (
              <button
                key={card.key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setChoice(card.key)}
                className={`flex flex-col gap-1.5 rounded-lg border px-4 py-4 text-left transition-all focus-visible:outline-2 focus-visible:outline-primary ${
                  selected
                    ? "border-primary bg-primary-soft"
                    : "border-subtle bg-surface-raised/40 hover:border-strong"
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                    {card.icon}
                    {card.label}
                  </span>
                  {selected && <Check className="size-4 text-primary" aria-hidden />}
                </span>
                <span className="text-xs text-muted">{card.body}</span>
              </button>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

function BrandingTab(): ReactNode {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const store = useStoreQuery();
  const patch = usePatchSettingsMutation();
  const canEdit = hasPermission("settings:update");

  const branding = store.data?.settings?.branding ?? {};
  const ai = store.data?.settings?.aiPreferences ?? {};

  const [color, setColor] = useState("");
  const [autonomy, setAutonomy] = useState<string>(AutomationMode.Manual);

  useEffect(() => {
    const saved = branding["primaryColor"];
    setColor(typeof saved === "string" ? saved : "");
    const mode = ai["autonomyMode"];
    setAutonomy(typeof mode === "string" ? mode : AutomationMode.Manual);
  }, [store.data]);

  const colorValid = color === "" || HEX_PATTERN.test(color);

  const onSave = (): void => {
    patch.mutate(
      {
        branding: color === "" ? { primaryColor: "" } : { primaryColor: color },
        aiPreferences: { autonomyMode: autonomy },
      },
      {
        onSuccess: () => toast.success("Preferences saved", "Branding and AI preferences are stored on your store profile."),
        onError: (error: ApiError) => toast.error("Could not save preferences", error.message),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Branding" subtitle="Accent overrides applied to your workspace surfaces." />
        <CardBody className="flex flex-col gap-4">
          <div className="max-w-xs">
            <label htmlFor="brand-color" className="mb-1.5 block text-xs font-medium text-muted">
              Primary color (hex)
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="brand-color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                placeholder="#6d6af8 — leave empty for default"
                invalid={!colorValid}
                disabled={!canEdit}
              />
              <span
                className="size-10 shrink-0 rounded-md border border-subtle"
                style={{ backgroundColor: colorValid && color !== "" ? color : "var(--color-primary)" }}
                aria-hidden
              />
            </div>
            {!colorValid && <p className="mt-1.5 text-xs text-danger">Use #rgb or #rrggbb hex notation.</p>}
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="AI preferences"
          subtitle="How autonomously the AI engine may act once it activates on your store."
        />
        <CardBody className="flex flex-col gap-4">
          <div className="max-w-xs">
            <label htmlFor="autonomy-mode" className="mb-1.5 block text-xs font-medium text-muted">
              Autonomy mode
            </label>
            <Select id="autonomy-mode" value={autonomy} onChange={(event) => setAutonomy(event.target.value)} disabled={!canEdit}>
              <option value={AutomationMode.Manual}>Manual — propose only, I approve everything</option>
              <option value={AutomationMode.SemiAutomatic}>Semi-automatic — auto-execute low-risk actions</option>
              <option value={AutomationMode.FullyAutomatic}>Fully automatic — execute within guardrails</option>
            </Select>
          </div>
          <p className="rounded-md bg-ai-soft px-3.5 py-2.5 text-xs leading-relaxed text-ai">
            This is a real persisted preference: the AI engine (arriving with the Recommendations milestone)
            reads it before executing anything. Choosing Manual today means every future AI action still waits
            for your approval.
          </p>
        </CardBody>
      </Card>
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={onSave} loading={patch.isPending} disabled={!colorValid}>
            Save preferences
          </Button>
        </div>
      )}
      {!canEdit && (
        <p className="text-xs text-faint">Your role can view these settings; an owner or admin can change them.</p>
      )}
    </div>
  );
}

export function SettingsPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const initial = params.get("tab");
  const [tab, setTab] = useState<TabKey>(isTabKey(initial) ? initial : "general");

  const onTab = (key: string): void => {
    const next = isTabKey(key) ? key : "general";
    setTab(next);
    setParams(next === "general" ? {} : { tab: next }, { replace: true });
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Store profile, appearance, branding, AI preferences and the data pipeline." />
      <Tabs items={TABS.map((t) => ({ key: t.key, label: t.label }))} active={tab} onChange={onTab} className="mb-6" />
      {tab === "general" && <GeneralTab />}
      {tab === "appearance" && <AppearanceTab />}
      {tab === "branding" && <BrandingTab />}
      {tab === "sync" && <SyncManager />}
    </div>
  );
}
