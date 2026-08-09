import { useEffect, useState, type ReactNode } from "react";
import { CalendarClock, Download, Mail, Plus, ScrollText } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Input,
  Modal,
  Select,
  SkeletonText,
  useToast,
  formatMoney,
  type ColumnDef,
} from "@profit/ui";
import { FactsTable } from "../components/FactsTable";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatDateTime } from "../lib/format";
import { usePatchSettingsMutation, useStoreQuery } from "../lib/queries";
import {
  useEmailReportMutation,
  useGenerateReportMutation,
  useReportDetailQuery,
  useReportDownloadMutation,
  useReportsQuery,
} from "../lib/report-queries";
import type {
  ReportKindDto,
  ReportListItemDto,
  ReportSectionsDto,
  ReportStatusDto,
} from "../lib/api-types";

/**
 * Report vault (M8, ADR 34): scheduled + on-demand deterministic business
 * reports — PDF bytes stored server-side, an Executive-agent summary when an
 * AI provider is configured, email delivery via the same preferences the
 * worker's scheduled tick reads.
 */

const KIND_LABEL: Record<ReportKindDto, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
};

const STATUS_TONE: Record<ReportStatusDto, "success" | "danger" | "info"> = {
  BUILDING: "info",
  READY: "success",
  FAILED: "danger",
};

const DEFAULT_KINDS: Record<ReportKindDto, boolean> = {
  DAILY: false,
  WEEKLY: true,
  MONTHLY: true,
  QUARTERLY: false,
};

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${String(bytes)} B`;
  return `${String(Math.round(bytes / 1024))} KB`;
}

/** Scheduled-generation + delivery preferences (worker reads the same row). */
function ReportScheduleCard(): ReactNode {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("reports:manage");
  const toast = useToast();
  const store = useStoreQuery();
  const patch = usePatchSettingsMutation();

  const [kinds, setKinds] = useState<Record<ReportKindDto, boolean>>({ ...DEFAULT_KINDS });
  const [emailDelivery, setEmailDelivery] = useState<boolean>(false);
  const [recipient, setRecipient] = useState<string>("");

  useEffect(() => {
    const prefs = store.data?.settings?.reportPreferences;
    if (prefs === undefined || prefs === null) return;
    const seeded = { ...DEFAULT_KINDS };
    for (const kind of Object.keys(KIND_LABEL) as readonly ReportKindDto[]) {
      const value = prefs.kinds?.[kind];
      if (typeof value === "boolean") seeded[kind] = value;
    }
    setKinds(seeded);
    setEmailDelivery(prefs.emailDelivery === true);
    setRecipient(typeof prefs.recipientEmail === "string" ? prefs.recipientEmail : "");
  }, [store.data]);

  const toggleKind = (kind: ReportKindDto): void => {
    setKinds((current) => ({ ...current, [kind]: !current[kind] }));
  };

  const save = (): void => {
    const trimmed = recipient.trim();
    patch.mutate(
      {
        reportPreferences: {
          kinds,
          emailDelivery,
          recipientEmail: trimmed === "" ? null : trimmed,
        },
      },
      {
        onSuccess: () => toast.success("Report schedule saved", "The worker's next scheduled tick picks these preferences up."),
        onError: (error: ApiError) => toast.error("Could not save the schedule", error.message),
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <CalendarClock className="size-4 text-primary" aria-hidden />
            Scheduled reports
          </span>
        }
        subtitle="The worker closes each period and files the finished PDF here — enable email and it lands in your inbox too."
      />
      <CardBody>
        <QueryBoundary query={store} compact loading={<SkeletonText lines={2} />}>
          <div className="flex flex-col gap-4">
            <fieldset>
              <legend className="sr-only">Report kinds to generate automatically</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {(Object.keys(KIND_LABEL) as readonly ReportKindDto[]).map((kind) => (
                  <label key={kind} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--pf-primary)]"
                      checked={kinds[kind]}
                      onChange={() => toggleKind(kind)}
                      disabled={!canManage}
                      aria-label={`Generate ${KIND_LABEL[kind]} reports automatically`}
                    />
                    {KIND_LABEL[kind]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--pf-primary)]"
                  checked={emailDelivery}
                  onChange={(event) => setEmailDelivery(event.target.checked)}
                  disabled={!canManage}
                  aria-label="Email reports when ready"
                />
                Email each report when it's ready
              </label>
              <label className="block min-w-56 flex-1">
                <span className="mb-1 block text-xs font-medium text-muted">Recipient (optional)</span>
                <Input
                  type="email"
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                  placeholder="Defaults to your store contact email"
                  disabled={!canManage}
                  aria-label="Report email recipient"
                />
              </label>
              {canManage && (
                <Button size="sm" onClick={save} loading={patch.isPending}>
                  Save schedule
                </Button>
              )}
            </div>
            {!canManage && <p className="text-xs text-faint">Your role can view the schedule; reports:manage is required to change it.</p>}
          </div>
        </QueryBoundary>
      </CardBody>
    </Card>
  );
}

function GenerateReportDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): ReactNode {
  const toast = useToast();
  const generate = useGenerateReportMutation();
  const [kind, setKind] = useState<ReportKindDto>("WEEKLY");

  const submit = (): void => {
    generate.mutate(kind, {
      onSuccess: (outcome) => {
        if (outcome.status === "READY") {
          toast.success("Report ready", `${KIND_LABEL[outcome.kind]} report for ${outcome.periodLabel} is filed in the vault.`);
        } else if (outcome.status === "FAILED") {
          toast.error("Report failed to build", outcome.errorMessage ?? "Open the report for details.");
        } else {
          toast.success("Report building", `${KIND_LABEL[outcome.kind]} report for ${outcome.periodLabel} is assembling.`);
        }
        onClose();
      },
      onError: (error) => toast.error("Report could not be generated", error.message),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate a report"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={generate.isPending}>
            Generate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="block max-w-xs">
          <span className="mb-1 block text-xs font-medium text-muted">Report kind</span>
          <Select value={kind} onChange={(event) => setKind(event.target.value as ReportKindDto)} aria-label="Report kind">
            {(Object.keys(KIND_LABEL) as readonly ReportKindDto[]).map((value) => (
              <option key={value} value={value}>
                {KIND_LABEL[value]}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-[11px] leading-relaxed text-faint">
          Manual generation targets the most recently closed period (e.g. last full week for Weekly). If that report
          already exists it's rebuilt in place — never duplicated.
        </p>
      </div>
    </Modal>
  );
}

function ReportSectionsView({ sections }: { readonly sections: ReportSectionsDto }): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        {sections.kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-lg border border-subtle bg-surface-raised/40 px-3 py-2.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-faint">{kpi.label}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{kpi.display}</p>
            {kpi.deltaPct !== null && kpi.deltaPct !== undefined && (
              <p className={`text-[11px] tabular-nums ${kpi.deltaPct >= 0 ? "text-success" : "text-danger"}`}>
                {`${kpi.deltaPct >= 0 ? "+" : ""}${String(kpi.deltaPct)}% vs prior period`}
              </p>
            )}
          </div>
        ))}
      </div>
      {sections.highlights.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Highlights</p>
          <ul className="list-inside list-disc space-y-1 text-xs text-muted">
            {sections.highlights.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <FactsTable table={sections.performance} />
      {sections.topProducts !== null && <FactsTable table={sections.topProducts} />}
      {sections.forecast !== null && (
        <div className="rounded-lg border border-subtle bg-surface-raised/40 px-3 py-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-faint">{`Forecast — next ${String(sections.forecast.horizonDays)} days`}</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {formatMoney(sections.forecast.expectedCents, sections.currency)}
            <span className="ml-2 text-xs font-normal text-muted">
              {`${formatMoney(sections.forecast.lowCents, sections.currency)} – ${formatMoney(sections.forecast.highCents, sections.currency)}`}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-faint">
            {`method ${sections.forecast.method} · ${String(sections.forecast.stockoutRisks)} stockout risks · ${String(sections.forecast.churnRisks)} churn risks`}
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
        <span>{`AI actions created: ${String(sections.actions.createdInPeriod)}`}</span>
        <span>{`Executed: ${String(sections.actions.executedInPeriod)}`}</span>
        <span>{`Open at period end: ${String(sections.actions.openPendingAtEnd)}`}</span>
      </div>
    </div>
  );
}

function ReportDrawer({ reportId, onClose }: { readonly reportId: string | null; readonly onClose: () => void }): ReactNode {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("reports:manage");
  const toast = useToast();
  const detail = useReportDetailQuery(reportId);
  const download = useReportDownloadMutation();
  const email = useEmailReportMutation();

  const report = detail.data;

  const savePdf = (): void => {
    if (reportId === null) return;
    download.mutate(reportId, {
      onSuccess: (file) => {
        const url = URL.createObjectURL(file.blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
      },
      onError: (error) => toast.error("Download failed", error.message),
    });
  };

  const sendEmail = (): void => {
    if (reportId === null) return;
    email.mutate({ id: reportId }, {
      onSuccess: (outcome) => {
        if (outcome.sent) {
          toast.success("Report emailed", "The PDF was sent to your configured recipient.");
        } else {
          const reason =
            outcome.reason === "email-unavailable"
              ? "Email delivery isn't configured on this environment — configure SMTP to enable it."
              : outcome.reason === "already-sent-today"
                ? "This report was already emailed today (idempotent per day)."
                : outcome.reason ?? "Unknown reason";
          toast.error("Report was not emailed", reason);
        }
      },
      onError: (error) => toast.error("Report could not be emailed", error.message),
    });
  };

  return (
    <Drawer
      open={reportId !== null}
      onClose={onClose}
      width="lg"
      title={report !== undefined ? `${KIND_LABEL[report.kind]} report — ${report.periodLabel}` : "Report"}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canManage && (
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<Mail className="size-3.5" aria-hidden />}
              onClick={sendEmail}
              loading={email.isPending}
              disabled={report?.status !== "READY"}
            >
              Email PDF
            </Button>
          )}
          <Button
            size="sm"
            iconLeft={<Download className="size-3.5" aria-hidden />}
            onClick={savePdf}
            loading={download.isPending}
            disabled={report?.status !== "READY"}
          >
            Download PDF
          </Button>
        </div>
      }
    >
      <QueryBoundary query={detail} loading={<SkeletonText lines={6} />}>
        {report !== undefined && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[report.status]}>{report.status}</Badge>
              <Badge tone="neutral">{`PDF ${formatSize(report.pdfSizeBytes)}`}</Badge>
              {report.lastEmailedOn !== null && <Badge tone="info">{`emailed ${report.lastEmailedOn}`}</Badge>}
              {report.completedAt !== null && (
                <span className="text-[11px] text-faint">{`completed ${formatDateTime(report.completedAt)}`}</span>
              )}
            </div>
            {report.status === "FAILED" && (
              <p className="rounded-md bg-danger-soft px-3.5 py-2.5 text-xs leading-relaxed text-danger">
                {report.errorMessage ?? "This report failed to build."}
              </p>
            )}
            {report.executiveSummary !== null && (
              <div className="rounded-lg border border-subtle bg-ai-soft px-3.5 py-3">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ai">Executive summary</p>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{report.executiveSummary}</p>
              </div>
            )}
            {report.sections !== null && <ReportSectionsView sections={report.sections} />}
          </div>
        )}
      </QueryBoundary>
    </Drawer>
  );
}

export function ReportsPage(): ReactNode {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("reports:manage");
  const [kindFilter, setKindFilter] = useState<ReportKindDto | "">("");
  const reports = useReportsQuery(kindFilter);
  const download = useReportDownloadMutation();
  const toast = useToast();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const savePdf = (row: ReportListItemDto): void => {
    download.mutate(row.id, {
      onSuccess: (file) => {
        const url = URL.createObjectURL(file.blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
      },
      onError: (error) => toast.error("Download failed", error.message),
    });
  };

  const columns: readonly ColumnDef<ReportListItemDto>[] = [
    {
      key: "period",
      header: "Report",
      cell: (row) => (
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-sm font-medium text-foreground">
            <Badge tone="neutral">{KIND_LABEL[row.kind]}</Badge>
            <span className="truncate">{row.periodLabel}</span>
          </p>
          {row.headline !== null && <p className="mt-0.5 truncate text-[11px] text-faint">{row.headline}</p>}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <div>
          <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
          {row.errorMessage !== null && <p className="mt-1 max-w-56 truncate text-[11px] text-danger">{row.errorMessage}</p>}
        </div>
      ),
    },
    {
      key: "pdf",
      header: "PDF",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatSize(row.pdfSizeBytes)}</span>,
    },
    {
      key: "emailed",
      header: "Emailed",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{row.lastEmailedOn ?? "—"}</span>,
    },
    {
      key: "created",
      header: "Generated",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.completedAt ?? row.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (row) => (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); setActiveId(row.id); }}>
            View
          </Button>
          {row.status === "READY" && (
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<Download className="size-3.5" aria-hidden />}
              onClick={(event) => { event.stopPropagation(); savePdf(row); }}
              loading={download.isPending && download.variables === row.id}
            >
              PDF
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="reports-page">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <ScrollText className="size-5 text-primary" aria-hidden />
            Enterprise Reports
          </span>
        }
        subtitle="Deterministic period reports with an Executive-agent summary — filed as PDFs, deliverable by email."
        actions={
          canManage ? (
            <Button iconLeft={<Plus className="size-4" aria-hidden />} onClick={() => setGenerateOpen(true)}>
              Generate report
            </Button>
          ) : undefined
        }
      />
      <ReportScheduleCard />
      <DataTable
        columns={columns}
        rows={reports.data ?? []}
        rowKey={(row) => row.id}
        loading={reports.isPending}
        onRowClick={(row) => setActiveId(row.id)}
        toolbar={
          <div className="w-44">
            <Select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as ReportKindDto | "")}
              aria-label="Filter by kind"
            >
              <option value="">All kinds</option>
              {(Object.keys(KIND_LABEL) as readonly ReportKindDto[]).map((value) => (
                <option key={value} value={value}>
                  {KIND_LABEL[value]}
                </option>
              ))}
            </Select>
          </div>
        }
        emptyState={
          <EmptyState
            icon={<ScrollText className="size-6" aria-hidden />}
            title="No reports yet"
            body={
              canManage
                ? "Reports build automatically at each period close — or generate one now for the most recent closed period."
                : "Reports your store schedules will appear here, filed as downloadable PDFs."
            }
          />
        }
      />
      <GenerateReportDialog open={generateOpen} onClose={() => setGenerateOpen(false)} />
      <ReportDrawer reportId={activeId} onClose={() => setActiveId(null)} />
    </div>
  );
}
