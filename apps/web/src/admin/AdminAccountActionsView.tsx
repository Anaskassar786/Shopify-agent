import { useState, type ReactNode } from "react";
import { KeyRound, Plus, Undo2 } from "lucide-react";
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
  useToast,
  type ColumnDef,
} from "@profit/ui";
import { AdminEmpty, AdminView } from "./AdminShared";
import { formatDateTime } from "../lib/format";
import {
  useAdminMerchantsQuery,
  useAdminOverridesQuery,
  useExtendTrialMutation,
  useGrantOverrideMutation,
  useRevokeOverrideMutation,
} from "../lib/admin-queries";
import type { AccessOverrideKindDto, AccessOverrideRowDto } from "../lib/api-types";
import type { AdminSession } from "./admin-session-store";

/**
 * Account actions (M6): the two support write paths — extend a trial (a
 * TRIALING window stacks; an EXPIRED one reactivates) and grant/revoke a
 * time-boxed access override (status-gate bypass for support incidents).
 * Both demand operator identity + reason; the server records them in
 * platform_admin_actions with this operator's id.
 */

const KIND_LABEL: Readonly<Record<AccessOverrideKindDto, string>> = {
  COMP_ACCESS: "Comp storefront access",
  PAUSED_EXTENSION: "Extend a billing pause",
  CHARGE_FAILURE_GRACE: "Grace after charge failure",
};

const KIND_HELP: Readonly<Record<AccessOverrideKindDto, string>> = {
  COMP_ACCESS: "Full read/write access while the store would otherwise be locked (support courtesy windows).",
  PAUSED_EXTENSION: "Keeps access running past a requested pause — e.g. seasonal stores.",
  CHARGE_FAILURE_GRACE: "Bridges a failed Shopify charge while the merchant fixes their payment method.",
};

function sessionHint(session: AdminSession | null): string | null {
  return session === null ? "Unlock write actions (top bar) before touching these." : null;
}

export function AdminAccountActionsView({
  adminKey,
  session,
}: {
  readonly adminKey: string;
  readonly session: AdminSession | null;
}): ReactNode {
  const toast = useToast();
  const merchants = useAdminMerchantsQuery({ adminKey }, 1);
  const [storeId, setStoreId] = useState("");
  const overrides = useAdminOverridesQuery({ adminKey }, storeId === "" ? null : storeId);

  const [days, setDays] = useState(7);
  const [trialReason, setTrialReason] = useState("");
  const [kind, setKind] = useState<AccessOverrideKindDto>("COMP_ACCESS");
  const [until, setUntil] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [confirming, setConfirming] = useState<"trial" | "grant" | null>(null);
  const [revoking, setRevoking] = useState<AccessOverrideRowDto | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const extendTrial = useExtendTrialMutation(adminKey, session);
  const grant = useGrantOverrideMutation(adminKey, session);
  const revoke = useRevokeOverrideMutation(adminKey, session);

  const blocked = sessionHint(session);
  const busy = extendTrial.isPending || grant.isPending || revoke.isPending;

  const reasonOk = (value: string): boolean => value.trim().length >= 3;

  const doExtend = (): void => {
    if (!reasonOk(trialReason)) return;
    extendTrial.mutate(
      { storeId, additionalDays: days, reason: trialReason.trim() },
      {
        onSuccess: (row) => {
          toast.success("Trial extended", `New trial end: ${row.trialEndsAt ?? "unchanged"}.`);
          setTrialReason("");
          setConfirming(null);
        },
        onError: (error) => {
          toast.error("Trial extension failed", error.message);
          setConfirming(null);
        },
      },
    );
  };

  const doGrant = (): void => {
    if (!reasonOk(grantReason) || until === "") return;
    grant.mutate(
      { storeId, kind, accessUntil: new Date(until).toISOString(), reason: grantReason.trim() },
      {
        onSuccess: () => {
          toast.success("Access override granted", `${KIND_LABEL[kind]} until ${new Date(until).toLocaleString()}.`);
          setGrantReason("");
          setUntil("");
          setConfirming(null);
        },
        onError: (error) => {
          toast.error("Override could not be granted", error.message);
          setConfirming(null);
        },
      },
    );
  };

  const doRevoke = (): void => {
    if (revoking === null || !reasonOk(revokeReason)) return;
    revoke.mutate(
      { storeId, overrideId: revoking.id, reason: revokeReason.trim() },
      {
        onSuccess: () => {
          toast.success("Override revoked", "The store falls back to its real billing gate immediately.");
          setRevoking(null);
          setRevokeReason("");
        },
        onError: (error) => {
          toast.error("Override could not be revoked", error.message);
          setRevoking(null);
        },
      },
    );
  };

  const overrideColumns: readonly ColumnDef<AccessOverrideRowDto>[] = [
    { key: "kind", header: "Kind", cell: (row) => <Badge tone="info">{KIND_LABEL[row.kind]}</Badge> },
    {
      key: "window",
      header: "Access until",
      cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.accessUntil)}</span>,
    },
    {
      key: "provenance",
      header: "Granted by",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-foreground">{row.grantedBy}</p>
          <p className="truncate text-[11px] text-faint">{row.reason}</p>
        </div>
      ),
    },
    {
      key: "state",
      header: "State",
      cell: (row) =>
        row.revokedAt !== null ? (
          <div className="min-w-0">
            <Badge tone="neutral">REVOKED</Badge>
            <p className="mt-0.5 truncate text-[10px] text-faint">
              {row.revokedBy ?? ""} · {row.revokeReason ?? ""}
            </p>
          </div>
        ) : (
          <Badge tone="success">ACTIVE</Badge>
        ),
    },
    {
      key: "act",
      header: "",
      align: "right",
      cell: (row) =>
        row.revokedAt === null && blocked === null ? (
          <Button size="sm" variant="ghost" iconLeft={<Undo2 className="size-3.5" aria-hidden />} onClick={() => setRevoking(row)} disabled={busy}>
            Revoke
          </Button>
        ) : null,
    },
  ];

  const storeOptions = (merchants.data ?? []).map((row) => ({ id: row.storeId, label: `${row.name} (${row.shopDomain})` }));

  return (
    <AdminView
      title="Account actions"
      subtitle="Support write actions on a merchant's billing window — operator-stamped, reasoned, undoable where undo exists."
      query={merchants}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Pick the store" subtitle="First 25 stores by install date — the full directory lives under Merchants" />
          <CardBody>
            <Select value={storeId} onChange={(event) => setStoreId(event.target.value)} aria-label="Store for account actions">
              <option value="">Select a store…</option>
              {storeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
            {blocked !== null && <p role="note" className="mt-2 text-xs text-warning">{blocked}</p>}
          </CardBody>
        </Card>

        {storeId !== "" && (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Extend trial" subtitle="TRIALING stacks days; EXPIRED reactivates with the remaining window re-opened" />
                <CardBody className="flex flex-col gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted">Extra days (1–90)</span>
                      <Input type="number" min={1} max={90} value={days} onChange={(event) => setDays(Math.round(Number(event.target.value)))} aria-label="Extra trial days" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted">Reason (audit)</span>
                      <Input value={trialReason} maxLength={500} onChange={(event) => setTrialReason(event.target.value)} aria-label="Trial extension reason" placeholder="Ticket #, merchant name, why" />
                    </label>
                  </div>
                  <Button
                    className="self-start"
                    size="sm"
                    disabled={blocked !== null || !reasonOk(trialReason) || busy}
                    onClick={() => setConfirming("trial")}
                  >
                    Extend by {days} day{days === 1 ? "" : "s"}
                  </Button>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Grant support access override" subtitle="Time-boxed bypass of the billing gate — never silent, always expiring" />
                <CardBody className="flex flex-col gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-xs font-medium text-muted">Kind</span>
                      <Select value={kind} onChange={(event) => setKind(event.target.value as AccessOverrideKindDto)} aria-label="Override kind">
                        {(Object.keys(KIND_LABEL) as readonly AccessOverrideKindDto[]).map((value) => (
                          <option key={value} value={value}>
                            {KIND_LABEL[value]}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <p className="text-[11px] leading-relaxed text-faint sm:col-span-2">{KIND_HELP[kind]}</p>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted">Access until</span>
                      <Input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} aria-label="Access until" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted">Reason (audit)</span>
                      <Input value={grantReason} maxLength={500} onChange={(event) => setGrantReason(event.target.value)} aria-label="Override reason" placeholder="Ticket #, merchant name, why" />
                    </label>
                  </div>
                  <Button
                    className="self-start"
                    size="sm"
                    iconLeft={<Plus className="size-3.5" aria-hidden />}
                    disabled={blocked !== null || until === "" || !reasonOk(grantReason) || busy}
                    onClick={() => setConfirming("grant")}
                  >
                    Grant override
                  </Button>
                </CardBody>
              </Card>
            </div>

            <Card>
              <CardHeader title="Access overrides on this store" subtitle="Newest first — revoked rows stay visible forever" />
              <CardBody className="px-0 pb-0 pt-1">
                <DataTable
                  columns={overrideColumns}
                  rows={overrides.data ?? []}
                  rowKey={(row) => row.id}
                  loading={overrides.isPending}
                  emptyState={<AdminEmpty title="No overrides" body="Granted access windows land here with their provenance." />}
                />
              </CardBody>
            </Card>
          </>
        )}
      </div>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming === "trial" ? `Extend trial by ${days} day${days === 1 ? "" : "s"}?` : "Grant access override?"}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)} disabled={busy}>
              Back
            </Button>
            <Button size="sm" onClick={confirming === "trial" ? doExtend : doGrant} loading={busy}>
              <KeyRound className="mr-1.5 size-3.5" aria-hidden />
              Confirm, operator {session?.operatorId ?? "?"}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          This writes immediately and is recorded in the operator action log as{" "}
          <code className="font-mono">{confirming === "trial" ? "EXTEND_TRIAL" : "GRANT_ACCESS_OVERRIDE"}</code> with your
          reason and identity. Store: <code className="font-mono">{storeId.slice(0, 8)}…</code>
        </p>
      </Modal>

      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking !== null ? KIND_LABEL[revoking.kind] : "override"}?`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRevoking(null)} disabled={busy}>
              Keep it
            </Button>
            <Button size="sm" variant="danger" onClick={doRevoke} loading={busy} disabled={!reasonOk(revokeReason)}>
              Revoke access
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted">
            The store's billing gate re-applies from the next request. The grant row stays visible as REVOKED with your reason.
          </p>
          <Input value={revokeReason} maxLength={500} onChange={(event) => setRevokeReason(event.target.value)} aria-label="Revoke reason" placeholder="Why is this ending early?" autoFocus />
        </div>
      </Modal>
    </AdminView>
  );
}
