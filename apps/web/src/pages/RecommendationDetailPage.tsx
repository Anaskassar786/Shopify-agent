import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Bot, FileSearch, ScrollText, Wrench } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Modal,
  SkeletonText,
  Textarea,
  useToast,
  formatMoney,
} from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatDateTime } from "../lib/format";
import {
  useApproveRecommendationMutation,
  useRecommendationDetailQuery,
  useRejectRecommendationMutation,
} from "../lib/queries";
import type { ActionExecutionRow, EvidenceSnapshot } from "../lib/api-types";
import {
  ConfidenceMeter,
  EXECUTION_STATUS_TONE,
  PRIORITY_TONE,
  priorityLabel,
  RECOMMENDATION_EVENT_LABEL,
  RECOMMENDATION_STATUS_TONE,
  recommendationTypeLabel,
  statusLabel,
} from "./ai-shared";
import { DecisionControls } from "./RecommendationsPage";

function Fact({ label, value }: { readonly label: string; readonly value: ReactNode }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-right text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function EvidencePanel({ evidence }: { readonly evidence: EvidenceSnapshot }): ReactNode {
  return (
    <Card>
      <CardHeader
        title="Evidence snapshot"
        subtitle="Captured once, at creation — the model cannot edit history later."
      />
      <CardBody className="flex flex-col gap-4">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-faint">Facts the engine used</h4>
          <ul className="mt-2 flex flex-col gap-1" aria-label="Evidence facts">
            {evidence.facts.map((fact) => (
              <li key={fact} className="flex items-start gap-2 text-sm text-muted">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" aria-hidden />
                {fact}
              </li>
            ))}
          </ul>
        </div>
        <dl aria-label="Calibration">
          <Fact label="Model confidence" value={evidence.calibration.modelConfidence} />
          <Fact label="Calibrated confidence" value={evidence.calibration.finalConfidence} />
          <Fact label="Model risk" value={priorityLabel(evidence.calibration.modelRisk)} />
          <Fact label="Guardrail risk" value={priorityLabel(evidence.calibration.finalRisk)} />
          <Fact label="Prompt" value={`${evidence.model.promptId} · ${evidence.model.promptVersion}`} />
          <Fact label="Rule" value={`${evidence.rule.id} · v${String(evidence.rule.version)}`} />
          <Fact label="Est. ROI" value={evidence.estimates.roiMultiple !== null ? `${evidence.estimates.roiMultiple.toFixed(2)}×` : "—"} />
        </dl>
        <p className="text-[11px] leading-relaxed text-faint">
          Estimates use {evidence.estimates.expectationBasis}; confidence was calibrated server-side from data depth
          and your past decisions ({evidence.calibration.tier.toLowerCase()} tier).
        </p>
      </CardBody>
    </Card>
  );
}

function ExecutionRows({ executions }: { readonly executions: readonly ActionExecutionRow[] }): ReactNode {
  if (executions.length === 0) {
    return <p className="py-3 text-sm text-muted">No executions recorded yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-subtle" aria-label="Executions">
      {executions.map((execution) => (
        <li key={execution.id} className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{recommendationTypeLabel(execution.actionType)}</p>
            {execution.errorMessage !== null && (
              <p className="truncate text-xs text-danger">{execution.errorMessage}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs text-muted">
              {execution.attempts} attempt{execution.attempts === 1 ? "" : "s"} · {formatDateTime(execution.createdAt)}
            </span>
            <Badge tone={EXECUTION_STATUS_TONE[execution.status] ?? "neutral"}>{statusLabel(execution.status)}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function RecommendationDetailPage(): ReactNode {
  const { id = "" } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const detail = useRecommendationDetailQuery(id);
  const approve = useApproveRecommendationMutation();
  const reject = useRejectRecommendationMutation();
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const rec = detail.data;
  const canApprove = hasPermission("recommendations:approve");
  const canReject = hasPermission("recommendations:reject");
  const busy = approve.isPending || reject.isPending;

  const confirmApprove = (): void => {
    approve.mutate(id, {
      onSuccess: (row) => {
        setApproveOpen(false);
        toast.success(
          row.status === "EXECUTED" ? "Executed" : "Execution queued",
          row.status === "EXECUTED" ? "The advisory action completed immediately." : "The tool worker picks it up within seconds.",
        );
      },
      onError: (error: ApiError) => {
        setApproveOpen(false);
        toast.error("Approval failed", error.message);
      },
    });
  };

  const confirmReject = (): void => {
    reject.mutate(
      { id, reason: rejectReason.trim() },
      {
        onSuccess: () => {
          setRejectOpen(false);
          setRejectReason("");
          toast.success("Recommendation rejected", "The engine won't re-offer this action for 30 days.");
        },
        onError: (error: ApiError) => {
          setRejectOpen(false);
          setRejectReason("");
          toast.error("Rejection failed", error.message);
        },
      },
    );
  };

  return (
    <div>
      <Link
        to="/recommendations"
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
      >
        <ArrowRight className="size-3 rotate-180" aria-hidden /> Back to recommendations
      </Link>
      <QueryBoundary query={detail} loading={<SkeletonText lines={5} />}>
        {rec !== undefined && (
          <>
            <PageHeader
              title={rec.title}
              subtitle={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Badge tone={PRIORITY_TONE[rec.priority] ?? "neutral"}>{priorityLabel(rec.priority)}</Badge>
                  <Badge tone={RECOMMENDATION_STATUS_TONE[rec.status] ?? "neutral"}>{statusLabel(rec.status)}</Badge>
                  <span>{recommendationTypeLabel(rec.type)}</span>
                  <span className="text-faint">·</span>
                  <span className="text-faint">{rec.agentId.replaceAll("_", " ").toLowerCase()} agent</span>
                </span>
              }
              actions={
                <DecisionControls
                  rec={rec}
                  canApprove={canApprove}
                  canReject={canReject}
                  busy={busy}
                  onApprove={() => setApproveOpen(true)}
                  onReject={() => setRejectOpen(true)}
                />
              }
            />

            <div className="grid gap-4 xl:grid-cols-3">
              <Card className="xl:col-span-2">
                <CardHeader title="Why this, why now" subtitle="The model's explanation — numbers come from deterministic rules, prose from the AI" />
                <CardBody className="flex flex-col gap-4">
                  <p className="text-sm leading-relaxed text-muted">{rec.description}</p>
                  <ul className="flex flex-col gap-2" aria-label="Reasoning">
                    {rec.reasoning.map((point) => (
                      <li key={point} className="flex items-start gap-2.5 text-sm text-foreground">
                        <Bot className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                        {point}
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-subtle bg-surface-raised p-3 tabular-nums">
                    <span className="text-sm">
                      <span className="text-faint">Estimated upside </span>
                      <span className="font-semibold text-success">+{formatMoney(rec.estimatedRevenueCents)}</span>
                    </span>
                    <span className="text-sm">
                      <span className="text-faint">Estimated cost </span>
                      <span className="font-semibold text-foreground">
                        {rec.estimatedCostCents > 0 ? formatMoney(rec.estimatedCostCents) : "$0.00"}
                      </span>
                    </span>
                    <span className="text-sm">
                      <span className="text-faint">Risk </span>
                      <Badge tone={rec.riskLevel === "HIGH" ? "danger" : rec.riskLevel === "MEDIUM" ? "warning" : "neutral"}>
                        {priorityLabel(rec.riskLevel)}
                      </Badge>
                    </span>
                  </div>
                  <div className="w-40">
                    <ConfidenceMeter value={rec.confidence} />
                  </div>
                  {rec.decisionReason !== null && rec.decisionReason !== "" && (
                    <p className="rounded-md bg-surface-raised px-3 py-2 text-xs text-muted">
                      Decision note: {rec.decisionReason}
                    </p>
                  )}
                </CardBody>
              </Card>
              {rec.evidence !== null && <EvidencePanel evidence={rec.evidence} />}
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader title="Timeline" subtitle="Append-only event trail (audit never deletes)" />
                <CardBody>
                  <ul className="flex flex-col" aria-label="Event timeline">
                    {rec.events.map((event, index) => (
                      <li key={event.id} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span className="mt-1 size-2 rounded-full bg-primary" aria-hidden />
                          {index < rec.events.length - 1 && <span className="w-px flex-1 bg-subtle" aria-hidden />}
                        </div>
                        <div className="pb-4">
                          <p className="text-sm font-medium text-foreground">
                            {RECOMMENDATION_EVENT_LABEL[event.event] ?? recommendationTypeLabel(event.event)}
                          </p>
                          <p className="text-[11px] text-faint">
                            {event.actorType === "AI" ? "AI engine" : event.actorType === "MERCHANT" ? "You" : "System"} ·{" "}
                            {formatDateTime(event.createdAt)}
                            {event.fromStatus !== null && event.toStatus !== null
                              ? ` · ${statusLabel(event.fromStatus)} → ${statusLabel(event.toStatus)}`
                              : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Executions" subtitle="Tool runs with idempotent checkpoints and typed failures" />
                <CardBody>
                  <ExecutionRows executions={rec.executions} />
                </CardBody>
              </Card>
            </div>
          </>
        )}
      </QueryBoundary>

      <ConfirmDialog
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        onConfirm={confirmApprove}
        title="Approve this recommendation?"
        body={
          rec !== undefined
            ? `"${rec.title}" will queue its ${recommendationTypeLabel(rec.actionType)} action. Every step is logged; you can trace it here afterwards.`
            : ""
        }
        confirmLabel="Approve & queue"
        loading={approve.isPending}
      />

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject this recommendation?"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRejectOpen(false)} disabled={reject.isPending}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={confirmReject} loading={reject.isPending}>
              Reject recommendation
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          The engine remembers rejections for 30 days and adjusts what it proposes next.
        </p>
        <label className="mt-3 block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Reason (optional)</span>
          <Textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="e.g. We already emailed this customer"
            maxLength={500}
          />
        </label>
      </Modal>
    </div>
  );
}
