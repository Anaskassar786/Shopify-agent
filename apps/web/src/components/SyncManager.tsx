import { useState, type ReactNode } from "react";
import { Database, RefreshCw } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  EmptyState,
  useToast,
  type BadgeTone,
  type ColumnDef,
} from "@profit/ui";
import type { SyncStatus } from "@profit/types";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatDateTime, formatRelativeTime } from "../lib/format";
import {
  useSyncHistoryQuery,
  useSyncStatusQuery,
  useTriggerFullSyncMutation,
  useTriggerModuleSyncMutation,
} from "../lib/queries";
import type { SyncHistoryRow, SyncModuleStatus } from "../lib/api-types";
import { QueryBoundary } from "./QueryBoundary";

/**
 * Full sync control surface (M2 engine, real jobs). Shared by Settings → Sync
 * and the onboarding wizard: per-module status + manual trigger, one-click
 * full sync behind a confirm, and the run history table. The realtime stream
 * keeps statuses live while jobs run (sync.* events invalidate the queries).
 */

export const MODULE_STATUS_TONE: Record<SyncStatus | "PENDING", BadgeTone> = {
  COMPLETED: "success",
  RUNNING: "info",
  PENDING: "neutral",
  FAILED: "danger",
  CANCELLED: "warning",
};

function modulePermission(module: string): string {
  return `${module.toLowerCase()}:sync`;
}

function moduleLabel(module: string): string {
  return module.charAt(0) + module.slice(1).toLowerCase();
}

function ModuleRow({ row }: { readonly row: SyncModuleStatus }): ReactNode {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const trigger = useTriggerModuleSyncMutation();
  const canTrigger = hasPermission(modulePermission(row.module));
  const running = row.status === "RUNNING";

  const onTrigger = (): void => {
    trigger.mutate(row.module, {
      onSuccess: () => toast.success(`${moduleLabel(row.module)} sync scheduled`, "Fresh data is on its way from Shopify."),
      onError: (error: ApiError) => toast.error("Sync could not be started", error.message),
    });
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-subtle bg-surface-raised/40 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] font-semibold text-foreground">{moduleLabel(row.module)}</p>
          <Badge tone={MODULE_STATUS_TONE[row.status]}>{row.status}</Badge>
          {row.mode !== null && <span className="text-[10px] uppercase tracking-wide text-faint">{row.mode}</span>}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {row.status === "FAILED" && row.errorMessage !== null
            ? row.errorMessage
            : row.finishedAt !== null
              ? `Synced ${formatRelativeTime(row.finishedAt)}${row.stats !== null ? ` · ${String(row.stats.processed)} records` : ""}`
              : "Never synced yet"}
          {row.retryCount > 0 && row.status === "FAILED" ? ` · retry ${String(row.retryCount)}` : ""}
        </p>
      </div>
      {canTrigger && (
        <Button
          variant="secondary"
          size="sm"
          loading={trigger.isPending}
          disabled={running}
          onClick={onTrigger}
          iconLeft={<RefreshCw className={`size-3.5 ${running ? "animate-spin" : ""}`} aria-hidden />}
        >
          {running ? "Running" : "Sync now"}
        </Button>
      )}
    </div>
  );
}

const historyColumns: readonly ColumnDef<SyncHistoryRow>[] = [
  {
    key: "module",
    header: "Module",
    cell: (row) => <span className="font-medium">{moduleLabel(row.module)}</span>,
  },
  {
    key: "mode",
    header: "Mode",
    cell: (row) => <span className="text-muted">{row.mode.toLowerCase()}</span>,
  },
  {
    key: "status",
    header: "Status",
    cell: (row) => <Badge tone={MODULE_STATUS_TONE[row.status]}>{row.status}</Badge>,
  },
  {
    key: "processed",
    header: "Processed",
    align: "right",
    cell: (row) => <span className="tabular-nums">{(row.stats["processed"] ?? 0).toLocaleString("en-US")}</span>,
  },
  {
    key: "error",
    header: "Error",
    cell: (row) =>
      row.errorMessage !== null ? (
        <span className="text-xs text-danger">{row.errorMessage}</span>
      ) : (
        <span className="text-faint">—</span>
      ),
  },
  {
    key: "finished",
    header: "Finished",
    align: "right",
    cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.finishedAt)}</span>,
  },
];

export function SyncManager({ compact = false }: { readonly compact?: boolean }): ReactNode {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const status = useSyncStatusQuery();
  const [historyPage, setHistoryPage] = useState(1);
  const history = useSyncHistoryQuery(historyPage);
  const fullSync = useTriggerFullSyncMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Full fan-out needs every module permission (server enforces identically).
  const canFullSync = (status.data?.modules ?? []).every((m) => hasPermission(modulePermission(m.module)));

  const onFullSync = (): void => {
    setConfirmOpen(false);
    fullSync.mutate(undefined, {
      onSuccess: () => toast.success("Full sync scheduled", "All modules will refresh from Shopify — the page updates live."),
      onError: (error: ApiError) => toast.error("Full sync could not be started", error.message),
    });
  };

  return (
    <Card>
      <CardHeader
        title="Data synchronization"
        subtitle="Live pipeline between Shopify and your workspace. Manual runs are rate-limited; background webhooks keep data fresh between runs."
        actions={
          canFullSync && !compact ? (
            <Button
              size="sm"
              iconLeft={<Database className="size-3.5" aria-hidden />}
              loading={fullSync.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              Sync everything
            </Button>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-2">
        {compact && canFullSync && (
          <Button
            size="sm"
            className="self-start"
            iconLeft={<Database className="size-3.5" aria-hidden />}
            loading={fullSync.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            Start full sync
          </Button>
        )}
        <QueryBoundary query={status} compact>
          {(status.data?.modules.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Database className="size-6" aria-hidden />}
              title="Sync has not run yet"
              body="Start a full sync to pull your catalog, customers and orders from Shopify."
            />
          ) : (
            status.data?.modules.map((row) => <ModuleRow key={row.module} row={row} />)
          )}
        </QueryBoundary>
      </CardBody>
      {!compact && (
        <div className="border-t border-subtle px-5 py-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Recent runs</p>
          <DataTable
            columns={historyColumns}
            rows={history.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={history.isPending}
            emptyState={
              <EmptyState
                icon={<Database className="size-6" aria-hidden />}
                title="No sync runs recorded"
                body="Trigger a module sync above and the run will be tracked here with stats and errors."
              />
            }
            pagination={
              history.data !== undefined
                ? {
                    page: history.data.page,
                    pageSize: history.data.pageSize,
                    totalItems: history.data.totalItems,
                    onPageChange: setHistoryPage,
                  }
                : undefined
            }
          />
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={onFullSync}
        title="Sync everything from Shopify?"
        body="This queues a full re-pull of products, customers, orders, inventory, collections, discounts and metafields. Existing data is updated in place; nothing is deleted. Large catalogs can take a few minutes."
        confirmLabel="Start full sync"
      />
    </Card>
  );
}
