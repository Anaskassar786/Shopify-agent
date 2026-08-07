import { useState, type ReactNode } from "react";
import { Download, FileDown, Plus } from "lucide-react";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Input,
  Modal,
  Select,
  useToast,
  type ColumnDef,
} from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../lib/auth-context";
import { formatDateTime } from "../lib/format";
import { useExportDownloadMutation, useExportsQuery, useRequestExportMutation } from "../lib/export-queries";
import type { ExportFormatDto, ExportKindDto, ExportRowDto } from "../lib/api-types";

const KIND_LABEL: Record<ExportKindDto, string> = {
  AUDIT_LOGS: "Audit log",
  CUSTOMERS: "Customers",
  ORDERS: "Orders",
  PRODUCTS: "Products",
  RECOMMENDATIONS: "Recommendations",
};

const STATUS_TONE: Record<string, "success" | "danger" | "info" | "warning" | "neutral"> = {
  QUEUED: "neutral",
  RUNNING: "info",
  READY: "success",
  FAILED: "danger",
};

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

function RequestExportDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): ReactNode {
  const toast = useToast();
  const request = useRequestExportMutation();
  const [kind, setKind] = useState<ExportKindDto>("ORDERS");
  const [format, setFormat] = useState<ExportFormatDto>("CSV");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const submit = (): void => {
    request.mutate(
      {
        kind,
        format,
        ...(from !== "" ? { from: new Date(from).toISOString() } : {}),
        ...(to !== "" ? { to: new Date(to).toISOString() } : {}),
      },
      {
        onSuccess: () => {
          toast.success("Export queued", "The worker builds the file in the background — this list refreshes itself.");
          onClose();
        },
        onError: (error) => toast.error("Export could not be queued", error.message),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request an export"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={request.isPending}>
            Queue export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Data</span>
            <Select value={kind} onChange={(event) => setKind(event.target.value as ExportKindDto)} aria-label="Export data">
              {(Object.keys(KIND_LABEL) as readonly ExportKindDto[]).map((value) => (
                <option key={value} value={value}>
                  {KIND_LABEL[value]}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Format</span>
            <Select value={format} onChange={(event) => setFormat(event.target.value as ExportFormatDto)} aria-label="Export format">
              <option value="CSV">CSV (spreadsheet-safe)</option>
              <option value="XLSX">Excel workbook</option>
              <option value="PDF">PDF report</option>
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">From (optional)</span>
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="From date" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">To (optional)</span>
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="To date" />
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          Exports hold your real rows — capped at 50,000 per file — and stay downloadable for 7 days, then are swept.
          The request itself is audit-logged.
        </p>
      </div>
    </Modal>
  );
}

export function ExportsPage(): ReactNode {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("exports:manage");
  const toast = useToast();
  const [page, setPage] = useState(1);
  const exportsQuery = useExportsQuery(page);
  const download = useExportDownloadMutation();
  const [requestOpen, setRequestOpen] = useState(false);

  const save = (row: ExportRowDto): void => {
    download.mutate(row, {
      onSuccess: (file) => {
        const url = URL.createObjectURL(file.blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.fileName;
        anchor.click();
        // Defer revocation so the navigation settles before the URL dies.
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
      },
      onError: (error) => toast.error("Download failed", error.message),
    });
  };

  const columns: readonly ColumnDef<ExportRowDto>[] = [
    {
      key: "kind",
      header: "Export",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{KIND_LABEL[row.kind]}</p>
          <p className="truncate text-[11px] text-faint">
            {row.format}
            {row.fileName !== null ? ` · ${row.fileName}` : ""} · requested {formatDateTime(row.createdAt)}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <div>
          <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge>
          {row.error !== null && <p className="mt-1 max-w-56 truncate text-[11px] text-danger">{row.error}</p>}
        </div>
      ),
    },
    {
      key: "rows",
      header: "Rows",
      align: "right",
      cell: (row) => <span className="tabular-nums text-xs text-muted">{row.rowCount ?? "—"}</span>,
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatSize(row.sizeBytes)}</span>,
    },
    {
      key: "expires",
      header: "Available until",
      align: "right",
      cell: (row) => (
        <span className="text-xs text-muted">{row.expiresAt !== null ? formatDateTime(row.expiresAt) : "—"}</span>
      ),
    },
    {
      key: "download",
      header: "",
      align: "right",
      cell: (row) =>
        row.status === "READY" ? (
          <Button size="sm" variant="secondary" iconLeft={<Download className="size-3.5" aria-hidden />} onClick={() => save(row)} loading={download.isPending && download.variables?.id === row.id}>
            Download
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Exports"
        subtitle="Queue CSV, Excel or PDF reports of your real data — built in the background, never blocking the app."
        actions={
          canManage ? (
            <Button iconLeft={<Plus className="size-4" aria-hidden />} onClick={() => setRequestOpen(true)}>
              New export
            </Button>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        rows={exportsQuery.data?.rows ?? []}
        rowKey={(row) => row.id}
        loading={exportsQuery.isPending}
        emptyState={
          <EmptyState
            icon={<FileDown className="size-6" aria-hidden />}
            title="No exports yet"
            body={
              canManage
                ? "Queue your first export — orders to a spreadsheet, the audit trail to PDF for your accountant."
                : "Exports your team queues will appear here."
            }
          />
        }
        pagination={
          exportsQuery.data !== undefined
            ? { page, pageSize: 25, totalItems: exportsQuery.data.total, onPageChange: setPage }
            : undefined
        }
      />
      <RequestExportDialog open={requestOpen} onClose={() => setRequestOpen(false)} />
    </div>
  );
}
