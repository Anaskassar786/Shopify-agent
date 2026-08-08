import { useState, type ReactNode } from "react";
import { ShieldCheck, Users } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, DataTable, ErrorState, Select, type ColumnDef } from "@profit/ui";
import { AdminEmpty, AdminView } from "./AdminShared";
import { formatDateTime } from "../lib/format";
import {
  useAdminAccessReviewQuery,
  useAdminMerchantsQuery,
  useAdminOperatorSessionsQuery,
} from "../lib/admin-queries";
import type { AccessReviewMemberDto, AccessReviewActionDto, OperatorSessionRowDto } from "../lib/api-types";

/**
 * Access review (M7 SOC-2-lite): the standing evidence surface for
 * audits — who holds access to this store (membership × role × permission
 * breadth), which support overrides are live, which operator writes touched
 * it, and who held admin write authority globally (step-up session ledger).
 * Read-only by contract: the key gate suffices, no step-up needed.
 */

const ROLE_TONE: Readonly<Record<string, "primary" | "info" | "success" | "neutral" | "warning" | "ai">> = {
  OWNER: "primary",
  ADMIN: "info",
};

const memberColumns: readonly ColumnDef<AccessReviewMemberDto>[] = [
  {
    key: "who",
    header: "User",
    cell: (row) => (
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-foreground">{row.fullName}</p>
        <p className="truncate font-mono text-[11px] text-muted">{row.email}</p>
      </div>
    ),
  },
  {
    key: "role",
    header: "Role",
    cell: (row) => <Badge tone={ROLE_TONE[row.roleCode] ?? "neutral"}>{row.roleCode}</Badge>,
  },
  {
    key: "breadth",
    header: "Permissions",
    cell: (row) => <span className="text-xs tabular-nums text-muted">{row.permissionCount} granted</span>,
  },
  {
    key: "status",
    header: "Status",
    cell: (row) => <Badge tone={row.status === "ACTIVE" ? "success" : "warning"}>{row.status}</Badge>,
  },
  {
    key: "since",
    header: "Member since",
    cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.memberSince)}</span>,
  },
  {
    key: "login",
    header: "Last sign-in",
    cell: (row) => <span className="text-xs text-muted">{row.lastLoginAt !== null ? formatDateTime(row.lastLoginAt) : "never"}</span>,
  },
];

const actionColumns: readonly ColumnDef<AccessReviewActionDto>[] = [
  {
    key: "when",
    header: "When",
    cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.createdAt)}</span>,
  },
  {
    key: "action",
    header: "Action",
    cell: (row) => <span className="font-mono text-[11px] text-foreground">{row.action}</span>,
  },
  {
    key: "operator",
    header: "Operator",
    cell: (row) => (
      <div className="min-w-0">
        <p className="truncate font-mono text-[11px] text-foreground">{row.operatorId}</p>
        <p className="truncate text-[10px] text-faint">{row.ip ?? "no ip"}</p>
      </div>
    ),
  },
  {
    key: "target",
    header: "Target",
    cell: (row) => (
      <span className="font-mono text-[11px] text-muted">
        {row.targetType}:{row.targetId.slice(0, 8)}…
      </span>
    ),
  },
];

const sessionColumns: readonly ColumnDef<OperatorSessionRowDto>[] = [
  {
    key: "when",
    header: "Granted at",
    cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.createdAt)}</span>,
  },
  {
    key: "operator",
    header: "Operator",
    cell: (row) => <span className="font-mono text-[11px] text-foreground">{row.operatorId}</span>,
  },
  {
    key: "ip",
    header: "From IP",
    cell: (row) => <span className="font-mono text-[11px] text-muted">{row.ip ?? "—"}</span>,
  },
];

export function AdminAccessReviewView({ adminKey }: { readonly adminKey: string }): ReactNode {
  const merchants = useAdminMerchantsQuery({ adminKey }, 1);
  const [storeId, setStoreId] = useState("");
  const review = useAdminAccessReviewQuery({ adminKey }, storeId === "" ? null : storeId);
  const sessions = useAdminOperatorSessionsQuery({ adminKey });

  const storeOptions = (merchants.data ?? []).map((row) => ({ id: row.storeId, label: `${row.name} (${row.shopDomain})` }));

  return (
    <AdminView
      title="Access review"
      subtitle="SOC-2-lite evidence: who can act on a store, through what role, and which operators touched it — straight from the RBAC + override + action ledgers."
      query={merchants}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Pick the store" subtitle="Reviews read live tables — stale exports are not evidence" />
          <CardBody>
            <Select value={storeId} onChange={(event) => setStoreId(event.target.value)} aria-label="Store for access review">
              <option value="">Select a store…</option>
              {storeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </CardBody>
        </Card>

        {storeId !== "" && review.isError && (
          <ErrorState
            title="Access review could not be loaded"
            body={review.error instanceof Error ? review.error.message : "The admin API did not answer as expected."}
            onRetry={() => void review.refetch()}
          />
        )}

        {storeId !== "" && !review.isError && review.data !== undefined && (
          <>
            <Card>
              <CardHeader
                title={`${review.data.store.name}`}
                subtitle={`${review.data.store.shopDomain} · installed ${formatDateTime(review.data.store.installedAt)}${
                  review.data.store.uninstalledAt !== null ? ` · uninstalled ${formatDateTime(review.data.store.uninstalledAt)}` : ""
                }`}
              />
              <CardBody className="px-0 pb-0 pt-1">
                <p className="flex items-center gap-2 px-5 pb-2 text-xs font-medium uppercase tracking-wide text-faint">
                  <Users className="size-3.5" aria-hidden /> Members &amp; role breadth
                </p>
                <DataTable
                  columns={memberColumns}
                  rows={review.data.members}
                  rowKey={(row) => row.userId}
                  loading={review.isPending}
                  emptyState={<AdminEmpty title="No members" body="Users provisioned on embedded sign-in appear here with their role." />}
                />
              </CardBody>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Live access overrides" subtitle="Time-boxed billing-gate bypasses currently in force" />
                <CardBody className="flex flex-col gap-2">
                  {review.data.activeOverrides.length === 0 && (
                    <AdminEmpty title="No active overrides" body="Granted support windows land here while they run." />
                  )}
                  {review.data.activeOverrides.map((row) => (
                    <div key={row.id} className="rounded-lg border border-subtle bg-surface px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone="warning">{row.kind}</Badge>
                        <span className="text-[11px] text-muted">until {formatDateTime(row.accessUntil)}</span>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted">{row.reason}</p>
                      <p className="mt-1 font-mono text-[10px] text-faint">
                        {row.grantedBy} · {formatDateTime(row.grantedAt)}
                      </p>
                    </div>
                  ))}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Recent operator writes" subtitle="Store-bound admin actions (25 newest)" />
                <CardBody className="px-0 pb-0 pt-1">
                  <DataTable
                    columns={actionColumns}
                    rows={review.data.recentActions}
                    rowKey={(row) => row.id}
                    loading={review.isPending}
                    emptyState={<AdminEmpty title="No operator writes" body="Trial extensions, overrides and ticket writes appear here." />}
                  />
                </CardBody>
              </Card>
            </div>
          </>
        )}

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-success" aria-hidden /> Write-authority grants
              </span>
            }
            subtitle="Every admin step-up session ever minted — operator identity, origin IP, time (all stores)"
          />
          <CardBody className="px-0 pb-0 pt-1">
            <DataTable
              columns={sessionColumns}
              rows={sessions.data ?? []}
              rowKey={(row) => `${row.operatorId}:${row.createdAt}`}
              loading={sessions.isPending}
              emptyState={<AdminEmpty title="No sessions yet" body="An operator unlocking write actions records the grant here." />}
            />
          </CardBody>
        </Card>
      </div>
    </AdminView>
  );
}
