import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, Wrench } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
  type ColumnDef,
} from "@profit/ui";
import { AdminView } from "./AdminShared";
import { formatDateTime } from "../lib/format";
import {
  useAdminFeatureFlagsQuery,
  useAdminMerchantsQuery,
  useAdminOpsFlagsQuery,
  useAdminOpsJobsQuery,
  useSetFeatureFlagsMutation,
  useSetMaintenanceMutation,
} from "../lib/admin-queries";
import type { AdminOpsQueueRow } from "../lib/api-types";
import type { AdminSession } from "./admin-session-store";

/**
 * Ops control plane (launch readiness, ADR 37):
 *  - maintenance mode: the ONLY platform-scope switch — engages on the next
 *    merchant request, leaves webhooks/session/legal/the console itself up;
 *  - per-merchant feature flags: contains a runaway capability (AI provider
 *    writes, workflow mutations) for ONE store without touching anyone else;
 *  - job queue: the durable-mirror readout (queued/running/failed/retries/DLQ)
 *    that stays truthful even with Redis down.
 * Every write is step-up-gated and lands in platform_admin_actions.
 */

const STATUS_BUCKETS: readonly { key: string; label: string; tone: "info" | "warning" | "success" | "danger" | "neutral" }[] = [
  { key: "QUEUED", label: "Queued", tone: "info" },
  { key: "RUNNING", label: "Running", tone: "warning" },
  { key: "COMPLETED", label: "Completed", tone: "success" },
  { key: "FAILED", label: "Failed", tone: "danger" },
  { key: "DEAD_LETTERED", label: "Dead-lettered", tone: "danger" },
];

function reasonOk(value: string): boolean {
  return value.trim().length >= 3;
}

export function AdminOpsView({
  adminKey,
  session,
}: {
  readonly adminKey: string;
  readonly session: AdminSession | null;
}): ReactNode {
  const toast = useToast();
  const flags = useAdminOpsFlagsQuery({ adminKey });
  const jobs = useAdminOpsJobsQuery({ adminKey });
  const merchants = useAdminMerchantsQuery({ adminKey }, 1);

  const maintenance = flags.data?.maintenance ?? null;
  const [message, setMessage] = useState("");
  const [messageTouched, setMessageTouched] = useState(false);
  const [maintReason, setMaintReason] = useState("");
  const [confirming, setConfirming] = useState<"enable" | "disable" | "flags" | null>(null);

  // Prefill the textarea with the live operator message exactly once — an
  // operator mid-edit must never be clobbered by a background refresh.
  useEffect(() => {
    if (!messageTouched && maintenance?.message !== undefined && maintenance?.message !== null) {
      setMessage(maintenance.message);
    }
  }, [maintenance, messageTouched]);

  const [flagStoreId, setFlagStoreId] = useState("");
  const currentFlags = useAdminFeatureFlagsQuery({ adminKey }, flagStoreId === "" ? null : flagStoreId);
  const [aiDisabled, setAiDisabled] = useState(false);
  const [automationDisabled, setAutomationDisabled] = useState(false);
  const [flagsTouched, setFlagsTouched] = useState(false);
  const [flagReason, setFlagReason] = useState("");

  useEffect(() => {
    if (!flagsTouched && currentFlags.data !== undefined) {
      setAiDisabled(currentFlags.data.flags["aiDisabled"] === true);
      setAutomationDisabled(currentFlags.data.flags["automationDisabled"] === true);
    }
  }, [currentFlags.data, flagsTouched]);

  const setMaintenance = useSetMaintenanceMutation(adminKey, session);
  const setFeatureFlags = useSetFeatureFlagsMutation(adminKey, session);
  const busy = setMaintenance.isPending || setFeatureFlags.isPending;
  const blocked = session === null ? "Unlock write actions (top bar) before touching these." : null;

  const doMaintenance = (enabled: boolean): void => {
    if (!reasonOk(maintReason)) return;
    const trimmed = message.trim();
    setMaintenance.mutate(
      { enabled, message: trimmed === "" ? null : trimmed, reason: maintReason.trim() },
      {
        onSuccess: () => {
          toast.success(
            enabled ? "Maintenance mode ON" : "Maintenance mode OFF",
            enabled
              ? "Merchant data plane now serves the maintenance notice; webhooks keep flowing."
              : "The merchant plane recovers on its next request.",
          );
          setMaintReason("");
          setMessageTouched(false);
          setConfirming(null);
        },
        onError: (error) => {
          toast.error("Maintenance toggle failed", error.message);
          setConfirming(null);
        },
      },
    );
  };

  const doFlags = (): void => {
    if (flagStoreId === "" || !reasonOk(flagReason)) return;
    setFeatureFlags.mutate(
      { storeId: flagStoreId, flags: { aiDisabled, automationDisabled }, reason: flagReason.trim() },
      {
        onSuccess: () => {
          toast.success("Feature flags updated", "Enforcement points pick this up on the next write.");
          setFlagReason("");
          setFlagsTouched(false);
          setConfirming(null);
        },
        onError: (error) => {
          toast.error("Feature flags could not be saved", error.message);
          setConfirming(null);
        },
      },
    );
  };

  const queueColumns: readonly ColumnDef<AdminOpsQueueRow>[] = [
    { key: "queue", header: "Queue", cell: (row) => <span className="font-mono text-xs text-foreground">{row.queue}</span> },
    { key: "queued", header: "Queued", align: "right", cell: (row) => <span className="tabular-nums">{row.queued}</span> },
    { key: "running", header: "Running", align: "right", cell: (row) => <span className="tabular-nums">{row.running}</span> },
    {
      key: "failed",
      header: "Failed/DLQ",
      align: "right",
      cell: (row) => <span className={row.failed > 0 ? "font-semibold text-danger tabular-nums" : "tabular-nums"}>{row.failed}</span>,
    },
    { key: "attempts", header: "Attempts (retries)", align: "right", cell: (row) => <span className="tabular-nums">{row.attempts}</span> },
  ];

  const storeOptions = (merchants.data ?? []).map((row) => ({ id: row.storeId, label: `${row.name} (${row.shopDomain})` }));

  return (
    <AdminView
      title="Ops controls"
      subtitle="Maintenance mode, per-merchant containment flags, and the durable job-queue readout — step-up-gated, fully audited."
      query={flags}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="Maintenance mode"
            subtitle="Merchant data plane 503s with your message; webhooks, session boot, legal pages and this console stay up by design"
          />
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {maintenance === null ? (
                <Badge tone="neutral">NEVER ENGAGED</Badge>
              ) : maintenance.enabled ? (
                <Badge tone="warning">MAINTENANCE ON</Badge>
              ) : (
                <Badge tone="success">OFF</Badge>
              )}
              {maintenance !== null && (
                <span className="text-[11px] text-faint">
                  last set by {maintenance.setBy} · {formatDateTime(maintenance.setAt)}
                </span>
              )}
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Merchant-facing message (blank = platform default)</span>
              <Textarea
                rows={2}
                maxLength={500}
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  setMessageTouched(true);
                }}
                aria-label="Maintenance message"
                placeholder="Shown on every merchant surface while maintenance is on."
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Reason (audit)</span>
              <Input
                value={maintReason}
                maxLength={500}
                onChange={(event) => setMaintReason(event.target.value)}
                aria-label="Maintenance reason"
                placeholder="Deploy ticket, migration id, incident ref"
              />
            </label>
            {blocked !== null && <p role="note" className="text-xs text-warning">{blocked}</p>}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<Wrench className="size-3.5" aria-hidden />}
                disabled={blocked !== null || !reasonOk(maintReason) || busy || maintenance?.enabled === true}
                onClick={() => setConfirming("enable")}
              >
                Engage maintenance
              </Button>
              <Button
                size="sm"
                disabled={blocked !== null || !reasonOk(maintReason) || busy || maintenance?.enabled !== true}
                onClick={() => setConfirming("disable")}
              >
                Lift maintenance
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Per-merchant feature flags"
            subtitle="Contain one store without touching anyone else — reads always stay open; only the flagged write paths 503"
          />
          <CardBody className="flex flex-col gap-3">
            <Select
              value={flagStoreId}
              onChange={(event) => {
                setFlagStoreId(event.target.value);
                setFlagsTouched(false);
              }}
              aria-label="Store for feature flags"
            >
              <option value="">Select a store…</option>
              {storeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
            {flagStoreId !== "" && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex items-start gap-2 rounded-md border border-subtle px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-[var(--color-primary)]"
                      checked={aiDisabled}
                      onChange={(event) => {
                        setAiDisabled(event.target.checked);
                        setFlagsTouched(true);
                      }}
                      aria-label="Disable AI features for this store"
                    />
                    <span>
                      <span className="block text-xs font-semibold text-foreground">Disable AI features</span>
                      <span className="block text-[11px] leading-relaxed text-faint">
                        Manual AI runs + copilot asks 503 FEATURE_DISABLED; dashboards and history stay readable.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 rounded-md border border-subtle px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-[var(--color-primary)]"
                      checked={automationDisabled}
                      onChange={(event) => {
                        setAutomationDisabled(event.target.checked);
                        setFlagsTouched(true);
                      }}
                      aria-label="Disable automation for this store"
                    />
                    <span>
                      <span className="block text-xs font-semibold text-foreground">Disable automation</span>
                      <span className="block text-[11px] leading-relaxed text-faint">
                        Workflow saves/activations/runs stop; scheduled run-starts skip loudly; in-flight runs finish.
                      </span>
                    </span>
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Reason (audit)</span>
                  <Input
                    value={flagReason}
                    maxLength={500}
                    onChange={(event) => setFlagReason(event.target.value)}
                    aria-label="Feature flag reason"
                    placeholder="Incident ref, ticket #, why this store is contained"
                  />
                </label>
                <Button
                  className="self-start"
                  size="sm"
                  disabled={blocked !== null || !reasonOk(flagReason) || busy || currentFlags.isPending}
                  onClick={() => setConfirming("flags")}
                >
                  Save flags
                </Button>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Job queue"
            subtitle="Durable Postgres mirror of every queue — correct even when Redis is down"
          />
          <CardBody className="flex flex-col gap-3 px-0 pb-0 pt-1">
            <div className="flex flex-wrap items-center gap-2 px-4">
              {STATUS_BUCKETS.map((bucket) => (
                <Badge key={bucket.key} tone={bucket.tone}>
                  {bucket.label}: {jobs.data?.byStatus[bucket.key] ?? "—"}
                </Badge>
              ))}
              {jobs.data !== undefined && (
                <span className="text-[11px] text-faint">
                  failed 24h: {jobs.data.failedLast24h} · dead-lettered total: {jobs.data.deadLettered}
                  {jobs.data.latestActivityAt !== null && ` · last activity ${formatDateTime(jobs.data.latestActivityAt)}`}
                </span>
              )}
            </div>
            <DataTable
              columns={queueColumns}
              rows={jobs.data?.byQueue ?? []}
              rowKey={(row) => row.queue}
              loading={jobs.isPending}
              emptyState={<p className="px-6 py-8 text-center text-sm text-muted">No background jobs recorded yet.</p>}
            />
          </CardBody>
        </Card>
      </div>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={
          confirming === "enable"
            ? "Engage maintenance mode?"
            : confirming === "disable"
              ? "Lift maintenance mode?"
              : "Save feature flags?"
        }
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)} disabled={busy}>
              Back
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (confirming === "flags") {
                  doFlags();
                } else if (confirming !== null) {
                  doMaintenance(confirming === "enable");
                }
              }}
              loading={busy}
            >
              <KeyRound className="mr-1.5 size-3.5" aria-hidden />
              Confirm, operator {session?.operatorId ?? "?"}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          {confirming === "enable" &&
            "Every merchant data-plane request starts failing with your maintenance message on the NEXT request. Shopify webhooks, OAuth, legal pages and this console are unaffected."}
          {confirming === "disable" &&
            "The merchant plane recovers on its next request. The disable write is audited with your operator identity."}
          {confirming === "flags" &&
            `Flags for the selected store become: AI ${aiDisabled ? "DISABLED" : "enabled"}, automation ${automationDisabled ? "DISABLED" : "enabled"}. Enforcement is live on the next flagged write; reads never gate.`}
        </p>
      </Modal>
    </AdminView>
  );
}
