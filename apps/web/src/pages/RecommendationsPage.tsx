import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Lightbulb, Sparkles } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Input,
  Modal,
  Select,
  Tabs,
  Textarea,
  useToast,
  formatMoney,
  type ColumnDef,
} from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatRelativeTime } from "../lib/format";
import {
  useApproveRecommendationMutation,
  useRecommendationsQuery,
  useRejectRecommendationMutation,
  useRunAnalysisMutation,
} from "../lib/queries";
import type { RecommendationRow } from "../lib/api-types";
import {
  ConfidenceMeter,
  PRIORITY_TONE,
  priorityLabel,
  RECOMMENDATION_STATUS_TONE,
  recommendationTypeLabel,
  statusLabel,
} from "./ai-shared";

const STATUS_TABS = [
  { key: "PENDING_APPROVAL", label: "Needs decision" },
  { key: "APPROVED", label: "Approved" },
  { key: "EXECUTING", label: "Executing" },
  { key: "EXECUTED", label: "Executed" },
  { key: "MEASURED", label: "Measured" },
  { key: "REJECTED", label: "Rejected" },
  { key: "EXPIRED", label: "Expired" },
  { key: "FAILED", label: "Failed" },
  { key: "", label: "All" },
] as const;

export interface DecisionControlsProps {
  readonly rec: RecommendationRow;
  readonly canApprove: boolean;
  readonly canReject: boolean;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly compact?: boolean;
}

/** Approve/reject pair, shared by list rows and the detail hero. */
export function DecisionControls({
  rec,
  canApprove,
  canReject,
  busy,
  onApprove,
  onReject,
  compact = false,
}: DecisionControlsProps): ReactNode {
  if (rec.status !== "PENDING_APPROVAL") return null;
  if (!canApprove && !canReject) return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {canApprove && (
        <Button
          size={compact ? "sm" : "md"}
          disabled={busy}
          onClick={onApprove}
          aria-label={`Approve ${rec.title}`}
        >
          Approve
        </Button>
      )}
      {canReject && (
        <Button
          size={compact ? "sm" : "md"}
          variant="ghost"
          disabled={busy}
          onClick={onReject}
          aria-label={`Reject ${rec.title}`}
        >
          Reject
        </Button>
      )}
    </div>
  );
}

function roiLabel(rec: RecommendationRow): string | null {
  if (rec.estimatedCostCents <= 0) return null;
  const roi = rec.estimatedRevenueCents / rec.estimatedCostCents;
  return `ROI ${roi.toFixed(1)}×`;
}

export function RecommendationsPage(): ReactNode {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("PENDING_APPROVAL");
  const [priority, setPriority] = useState("");
  const [type, setType] = useState("");
  const list = useRecommendationsQuery({ page, status, priority, type });
  const approve = useApproveRecommendationMutation();
  const reject = useRejectRecommendationMutation();
  const run = useRunAnalysisMutation();

  const canApprove = hasPermission("recommendations:approve");
  const canReject = hasPermission("recommendations:reject");

  const [approveTarget, setApproveTarget] = useState<RecommendationRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<RecommendationRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const busy = approve.isPending || reject.isPending || run.isPending;

  const confirmApprove = (): void => {
    if (approveTarget === null) return;
    const target = approveTarget;
    approve.mutate(target.id, {
      onSuccess: (row) => {
        setApproveTarget(null);
        toast.success(
          row.status === "EXECUTED" ? "Executed" : "Execution queued",
          row.status === "EXECUTED"
            ? "That advisory action completed immediately — find it under Executed."
            : "The approved action is queued on its tool queue — progress shows under Executing.",
        );
      },
      onError: (error: ApiError) => {
        setApproveTarget(null);
        toast.error("Approval failed", error.message);
      },
    });
  };

  const confirmReject = (): void => {
    if (rejectTarget === null) return;
    const target = rejectTarget;
    reject.mutate(
      { id: target.id, reason: rejectReason.trim() },
      {
        onSuccess: () => {
          setRejectTarget(null);
          setRejectReason("");
          toast.success("Recommendation rejected", "The engine learns from this — it won't re-offer the same action for 30 days.");
        },
        onError: (error: ApiError) => {
          setRejectTarget(null);
          setRejectReason("");
          toast.error("Rejection failed", error.message);
        },
      },
    );
  };

  const onRun = (): void => {
    run.mutate(undefined, {
      onSuccess: () => toast.success("Analysis is running", "New recommendations land here the moment they're ready."),
      onError: (error: ApiError) => toast.error("Analysis could not start", error.message),
    });
  };

  const columns: readonly ColumnDef<RecommendationRow>[] = [
    {
      key: "title",
      header: "Recommendation",
      cell: (row) => (
        <div className="min-w-0">
          <Link
            to={`/recommendations/${row.id}`}
            className="block truncate font-medium text-foreground transition-colors hover:text-primary"
          >
            {row.title}
          </Link>
          <p className="truncate text-[11px] text-faint">
            {recommendationTypeLabel(row.type)} · {formatRelativeTime(row.createdAt)}
          </p>
        </div>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      cell: (row) => <Badge tone={PRIORITY_TONE[row.priority] ?? "neutral"}>{priorityLabel(row.priority)}</Badge>,
    },
    {
      key: "confidence",
      header: "Confidence",
      cell: (row) => <ConfidenceMeter value={row.confidence} />,
    },
    {
      key: "estimate",
      header: "Estimate",
      cell: (row) => (
        <div className="tabular-nums">
          <p className="text-sm font-medium text-success">+{formatMoney(row.estimatedRevenueCents)}</p>
          <p className="text-[11px] text-faint">
            {row.estimatedCostCents > 0 ? `${formatMoney(row.estimatedCostCents)} cost` : "no direct cost"}
            {roiLabel(row) !== null ? ` · ${roiLabel(row)}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "risk",
      header: "Risk",
      cell: (row) => (
        <Badge tone={row.riskLevel === "HIGH" ? "danger" : row.riskLevel === "MEDIUM" ? "warning" : "neutral"}>
          {priorityLabel(row.riskLevel)}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <Badge tone={RECOMMENDATION_STATUS_TONE[row.status] ?? "neutral"}>{statusLabel(row.status)}</Badge>
      ),
    },
    {
      key: "decision",
      header: "",
      align: "right",
      cell: (row) => (
        <DecisionControls
          rec={row}
          canApprove={canApprove}
          canReject={canReject}
          busy={busy}
          compact
          onApprove={() => setApproveTarget(row)}
          onReject={() => {
            setRejectTarget(row);
            setRejectReason("");
          }}
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Recommendations"
        subtitle="Ranked revenue actions the AI proposes with full evidence. Nothing executes until you — or your automation policy — approve it."
        actions={
          canApprove ? (
            <Button size="sm" variant="secondary" iconLeft={<Sparkles className="size-3.5" aria-hidden />} loading={run.isPending} onClick={onRun}>
              Run analysis now
            </Button>
          ) : undefined
        }
      />

      <QueryBoundary query={list}>
        <>
          <Tabs
            items={STATUS_TABS.map((tab) => ({ key: tab.key, label: tab.label }))}
            active={status}
            onChange={(key) => {
              setStatus(key);
              setPage(1);
            }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by priority"
              className="max-w-40"
            >
              <option value="">All priorities</option>
              <option value="CRITICAL">Critical</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </Select>
            <Input
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                setPage(1);
              }}
              placeholder="Type… e.g. RECOVER_ABANDONED_CART"
              aria-label="Filter by type"
              className="max-w-72"
            />
          </div>
          <div className="mt-4">
            <DataTable
              columns={columns}
              rows={list.data?.items ?? []}
              rowKey={(row) => row.id}
              loading={false}
              emptyState={
                <EmptyState
                  icon={<Lightbulb className="size-6" aria-hidden />}
                  title={status === "PENDING_APPROVAL" ? "Nothing waiting for a decision" : "No recommendations in this state"}
                  body={
                    status === ""
                      ? "Run an analysis and the engine will propose ranked actions with evidence here — never guesses, never hidden automation."
                      : "Switch the filter above to look at other states."
                  }
                  primaryAction={
                    status === "PENDING_APPROVAL" && canApprove ? (
                      <Button size="sm" onClick={onRun} loading={run.isPending}>
                        Run analysis now
                      </Button>
                    ) : undefined
                  }
                />
              }
              pagination={
                list.data !== undefined
                  ? {
                      page: list.data.page,
                      pageSize: list.data.pageSize,
                      totalItems: list.data.totalItems,
                      onPageChange: setPage,
                    }
                  : undefined
              }
            />
          </div>
        </>
      </QueryBoundary>

      <ConfirmDialog
        open={approveTarget !== null}
        onClose={() => setApproveTarget(null)}
        onConfirm={confirmApprove}
        title="Approve this recommendation?"
        body={
          approveTarget !== null
            ? `"${approveTarget.title}" will queue its ${recommendationTypeLabel(approveTarget.actionType)} action${
                approveTarget.estimatedCostCents > 0
                  ? ` at an estimated ${formatMoney(approveTarget.estimatedCostCents)} tool cost`
                  : " at no direct cost"
              }. Everything it does is logged and reversible from the audit trail.`
            : ""
        }
        confirmLabel="Approve & queue"
        loading={approve.isPending}
      />

      <Modal
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title="Reject this recommendation?"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRejectTarget(null)} disabled={reject.isPending}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={confirmReject} loading={reject.isPending}>
              Reject recommendation
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          {rejectTarget !== null ? `"${rejectTarget.title}"` : ""} moves to Rejected. The engine remembers the
          decision — and your reason if you share one — so future analysis gets sharper.
        </p>
        <label className="mt-3 block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Reason (optional)</span>
          <Textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="e.g. Discounting hurts my margin"
            maxLength={500}
          />
        </label>
      </Modal>
    </div>
  );
}
