import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ShieldCheck, Workflow } from "lucide-react";
import {
  AnimatedNumber,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Input,
  Select,
  SkeletonText,
  useToast,
  formatMoney,
  type ColumnDef,
} from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatDateTime } from "../lib/format";
import { useAutomationOverviewQuery, usePatchSettingsMutation } from "../lib/queries";
import type { AutomationOverviewResponse } from "../lib/api-types";
import { EXECUTION_STATUS_TONE, recommendationTypeLabel, statusLabel } from "./ai-shared";

interface PolicyDraft {
  mode: "MANUAL" | "SEMI_AUTOMATIC" | "FULLY_AUTOMATIC";
  abandonedCartEnabled: boolean;
  abandonedCartDelayHours: number;
  abandonedCartMinValueCents: number;
  abandonedCartDiscountPercent: number;
  maxAutoDiscountPercent: number;
  maxAutoApproveEstimatedRevenueCents: number;
}

function draftFromPolicy(policy: AutomationOverviewResponse["policy"]): PolicyDraft {
  return {
    mode: policy.mode,
    abandonedCartEnabled: policy.abandonedCartEnabled,
    abandonedCartDelayHours: policy.abandonedCartDelayHours,
    abandonedCartMinValueCents: policy.abandonedCartMinValueCents,
    abandonedCartDiscountPercent: policy.abandonedCartDiscountPercent,
    maxAutoDiscountPercent: policy.maxAutoDiscountPercent,
    maxAutoApproveEstimatedRevenueCents: policy.maxAutoApproveEstimatedRevenueCents,
  };
}

const MODE_EXPLANATION: Readonly<Record<PolicyDraft["mode"], string>> = {
  MANUAL: "Every action waits for your click in Recommendations. Nothing ever runs alone.",
  SEMI_AUTOMATIC: "Advisory actions (reports, restock notes) auto-complete. Anything that sends, discounts or spends stays behind your approval.",
  FULLY_AUTOMATIC: "The engine may also auto-run discount and email actions — but only inside BOTH caps below. High-risk or over-cap actions always return to you.",
};

function executionPreviewSummary(preview: unknown): string | null {
  if (preview === null || typeof preview !== "object") return null;
  const record = preview as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record["discountCode"] === "string") parts.push(`Code ${record["discountCode"]}`);
  if (typeof record["recipients"] === "number") parts.push(`${String(record["recipients"])} recipients`);
  if (typeof record["sentTo"] === "number") parts.push(`${String(record["sentTo"])} sent`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function AutomationPage(): ReactNode {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const overview = useAutomationOverviewQuery();
  const patch = usePatchSettingsMutation();
  const canEdit = hasPermission("settings:update");

  const server = overview.data;
  const [draft, setDraft] = useState<PolicyDraft | null>(null);

  // Hydrate the form once the live policy lands; afterwards the user owns edits.
  useEffect(() => {
    if (server !== undefined && draft === null) setDraft(draftFromPolicy(server.policy));
  }, [server, draft]);

  const dirty = useMemo(
    () => server !== undefined && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftFromPolicy(server.policy)),
    [server, draft],
  );

  const onSave = (): void => {
    if (draft === null) return;
    patch.mutate(
      {
        automationPreferences: {
          mode: draft.mode,
          abandonedCart: {
            enabled: draft.abandonedCartEnabled,
            delayHours: draft.abandonedCartDelayHours,
            minCartValueCents: draft.abandonedCartMinValueCents,
            discountPercent: draft.abandonedCartDiscountPercent,
          },
          autopilot: {
            maxDiscountPercent: draft.maxAutoDiscountPercent,
            maxEstimatedRevenueCents: draft.maxAutoApproveEstimatedRevenueCents,
          },
        },
      },
      {
        onSuccess: () => toast.success("Policy saved", "The engine respects these guardrails from its next run."),
        onError: (error: ApiError) => toast.error("Policy could not be saved", error.message),
      },
    );
  };

  const ledgerColumns: readonly ColumnDef<AutomationOverviewResponse["executions"][number]>[] = [
    {
      key: "action",
      header: "Action",
      cell: (row) => (
        <div className="min-w-0">
          <Link
            to={`/recommendations/${row.recommendationId}`}
            className="block truncate font-medium text-foreground transition-colors hover:text-primary"
          >
            {row.recommendationTitle}
          </Link>
          <p className="truncate text-[11px] text-faint">
            {recommendationTypeLabel(row.actionType)}
            {executionPreviewSummary(row.preview) !== null ? ` · ${executionPreviewSummary(row.preview)}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <div>
          <Badge tone={EXECUTION_STATUS_TONE[row.status] ?? "neutral"}>{statusLabel(row.status)}</Badge>
          {row.errorMessage !== null && <p className="mt-1 max-w-64 truncate text-[11px] text-danger">{row.errorMessage}</p>}
        </div>
      ),
    },
    {
      key: "attempts",
      header: "Attempts",
      align: "right",
      cell: (row) => <span className="tabular-nums text-sm text-muted">{row.attempts}</span>,
    },
    {
      key: "when",
      header: "Ran",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Automation"
        subtitle="Your guardrails for the AI engine — what it may do on its own, and hard caps it can never cross."
      />

      <QueryBoundary query={overview} loading={<SkeletonText lines={6} />}>
        {server !== undefined && draft !== null && (
          <div className="grid gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <CardHeader
                title="Autonomy policy"
                subtitle="Writes through Store Settings (one settings channel); the engine reads it on every run"
              />
              <CardBody className="flex flex-col gap-5">
                {canEdit ? (
                  <>
                    <div>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-muted">Autonomy mode</span>
                        <Select
                          value={draft.mode}
                          onChange={(event) => setDraft({ ...draft, mode: event.target.value as PolicyDraft["mode"] })}
                          aria-label="Autonomy mode"
                        >
                          <option value="MANUAL">Manual — approve everything yourself</option>
                          <option value="SEMI_AUTOMATIC">Semi-automatic — advisories run alone</option>
                          <option value="FULLY_AUTOMATIC">Fully automatic — capped autopilot</option>
                        </Select>
                      </label>
                      <p className="mt-1.5 text-xs leading-relaxed text-faint">{MODE_EXPLANATION[draft.mode]}</p>
                    </div>

                    <fieldset className="rounded-lg border border-subtle p-4">
                      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-faint">
                        Abandoned-cart recovery
                      </legend>
                      <div className="flex flex-col gap-3">
                        <label className="flex items-center gap-2 text-sm text-foreground">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--pf-primary)]"
                            checked={draft.abandonedCartEnabled}
                            onChange={(event) => setDraft({ ...draft, abandonedCartEnabled: event.target.checked })}
                            aria-label="Detect abandoned carts"
                          />
                          Detect abandoned carts and propose recovery
                        </label>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-muted">Send after (hours idle)</span>
                            <Input
                              type="number"
                              min={1}
                              max={72}
                              value={draft.abandonedCartDelayHours}
                              onChange={(event) => setDraft({ ...draft, abandonedCartDelayHours: Number(event.target.value) })}
                              aria-label="Send after (hours idle)"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-muted">Minimum cart value</span>
                            <Input
                              type="number"
                              min={0}
                              step="1"
                              value={draft.abandonedCartMinValueCents / 100}
                              onChange={(event) =>
                                setDraft({ ...draft, abandonedCartMinValueCents: Math.round(Number(event.target.value) * 100) })
                              }
                              aria-label="Minimum cart value"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-muted">Discount percent</span>
                            <Input
                              type="number"
                              min={0}
                              max={50}
                              value={draft.abandonedCartDiscountPercent}
                              onChange={(event) => setDraft({ ...draft, abandonedCartDiscountPercent: Number(event.target.value) })}
                              aria-label="Discount percent"
                            />
                          </label>
                        </div>
                      </div>
                    </fieldset>

                    <fieldset className="rounded-lg border border-subtle p-4">
                      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-faint">
                        Autopilot hard caps (always enforced)
                      </legend>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-muted">Max auto-discount %</span>
                          <Input
                            type="number"
                            min={5}
                            max={50}
                            value={draft.maxAutoDiscountPercent}
                            onChange={(event) => setDraft({ ...draft, maxAutoDiscountPercent: Number(event.target.value) })}
                            aria-label="Maximum auto discount percent"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-muted">Max auto-approve value</span>
                          <Input
                            type="number"
                            min={0}
                            step="1"
                            value={draft.maxAutoApproveEstimatedRevenueCents / 100}
                            onChange={(event) =>
                              setDraft({ ...draft, maxAutoApproveEstimatedRevenueCents: Math.round(Number(event.target.value) * 100) })
                            }
                            aria-label="Maximum auto-approve value"
                          />
                        </label>
                      </div>
                      <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-faint">
                        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        Beyond either cap, the recommendation returns to the approval queue — the engine can never
                        outrun these numbers, even if its own estimate claims otherwise.
                      </p>
                    </fieldset>

                    <Button className="self-start" onClick={onSave} loading={patch.isPending} disabled={!dirty}>
                      Save automation policy
                    </Button>
                  </>
                ) : (
                  <div className="flex flex-col gap-2" aria-label="Policy summary">
                    <Fact line={`Mode: ${draft.mode.replaceAll("_", " ").toLowerCase()}`} />
                    <Fact line={`Abandoned-cart recovery: ${draft.abandonedCartEnabled ? "on" : "off"} · after ${String(draft.abandonedCartDelayHours)}h idle · ${String(draft.abandonedCartDiscountPercent)}% discount`} />
                    <Fact line={`Autopilot caps: ≤${String(draft.maxAutoDiscountPercent)}% discount · ≤${formatMoney(draft.maxAutoApproveEstimatedRevenueCents)} estimated value`} />
                    <p className="mt-1 text-xs text-faint">Only store managers can change automation policy.</p>
                  </div>
                )}
              </CardBody>
            </Card>

            <div className="flex flex-col gap-4 xl:col-span-2">
              <Card>
                <CardHeader title="Current guardrails" subtitle="Read straight from the live policy" />
                <CardBody>
                  <dl className="flex flex-col divide-y divide-subtle" aria-label="Current policy">
                    <PolicyFact label="Mode" value={server.policy.mode.replaceAll("_", " ")} />
                    <PolicyFact label="Abandoned-cart recovery" value={server.policy.abandonedCartEnabled ? `on · ${String(server.policy.abandonedCartDelayHours)}h delay` : "off"} />
                    <PolicyFact label="Cart floor" value={formatMoney(server.policy.abandonedCartMinValueCents)} />
                    <PolicyFact label="Recovery discount" value={`${String(server.policy.abandonedCartDiscountPercent)}%`} />
                    <PolicyFact label="Auto-discount cap" value={`${String(server.policy.maxAutoDiscountPercent)}%`} />
                    <PolicyFact label="Auto-approve cap" value={formatMoney(server.policy.maxAutoApproveEstimatedRevenueCents)} />
                  </dl>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Attributed outcomes" subtitle="Measured against real orders, deterministic matching only" />
                <CardBody>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-xl font-semibold tabular-nums text-foreground">
                        <AnimatedNumber value={server.outcomes.measuredCount} />
                      </p>
                      <p className="mt-1 text-[11px] text-muted">Measured</p>
                    </div>
                    <div>
                      <p className="text-xl font-semibold tabular-nums text-foreground">
                        <AnimatedNumber value={server.outcomes.attributedOrders} />
                      </p>
                      <p className="mt-1 text-[11px] text-muted">Orders</p>
                    </div>
                    <div>
                      <p className="text-xl font-semibold tabular-nums text-success">
                        {formatMoney(server.outcomes.attributedRevenueCents)}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">Revenue</p>
                    </div>
                  </div>
                </CardBody>
              </Card>
            </div>
          </div>
        )}
      </QueryBoundary>

      <div className="mt-4">
        <Card>
          <CardHeader
            title="Execution ledger"
            subtitle="Every automated action with its outcome — nothing runs off the books"
            actions={
              <Link
                to="/recommendations"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-strong"
              >
                Recommendation queue <ArrowRight className="size-3" aria-hidden />
              </Link>
            }
          />
          <CardBody>
            <DataTable
              columns={ledgerColumns}
              rows={server?.executions ?? []}
              rowKey={(row) => row.id}
              loading={overview.isPending}
              emptyState={
                <EmptyState
                  icon={<Workflow className="size-6" aria-hidden />}
                  title="No executions yet"
                  body="Approve a recommendation — or let autopilot act inside your caps — and the tool runs land here with their outcomes."
                />
              }
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function PolicyFact({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-right text-sm font-medium capitalize text-foreground">{value}</dd>
    </div>
  );
}

function Fact({ line }: { readonly line: string }): ReactNode {
  return <p className="text-sm capitalize leading-relaxed text-muted">{line}</p>;
}
