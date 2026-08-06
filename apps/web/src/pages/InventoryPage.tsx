import { useState, type ReactNode } from "react";
import { Boxes } from "lucide-react";
import { Badge, DataTable, EmptyState, Input, type ColumnDef } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { formatRelativeTime } from "../lib/format";
import { useInventoryLevelsQuery } from "../lib/queries";
import type { InventoryLevelRow } from "../lib/api-types";

export function stockTone(available: number): "danger" | "warning" | "success" {
  if (available <= 0) return "danger";
  if (available <= 5) return "warning";
  return "success";
}

export function InventoryPage(): ReactNode {
  const [page, setPage] = useState(1);
  const [belowInput, setBelowInput] = useState("");
  const parsedBelow = belowInput.trim() === "" ? null : Math.max(0, Math.floor(Number(belowInput)) || 0);
  const levels = useInventoryLevelsQuery(page, parsedBelow);

  const columns: readonly ColumnDef<InventoryLevelRow>[] = [
    {
      key: "product",
      header: "Product",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{row.productTitle}</p>
          <p className="truncate text-[11px] text-faint">{row.variantTitle ?? "Default title"}</p>
        </div>
      ),
    },
    {
      key: "sku",
      header: "SKU",
      cell: (row) =>
        row.sku !== null ? (
          <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px]">{row.sku}</code>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: "location",
      header: "Location",
      cell: (row) => <span className="text-muted">{row.locationName}</span>,
    },
    {
      key: "available",
      header: "Available",
      align: "right",
      cell: (row) => <Badge tone={stockTone(row.available)}>{row.available} units</Badge>,
    },
    {
      key: "updated",
      header: "Updated",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatRelativeTime(row.updatedAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle="Stock levels per variant and location, synced from Shopify. Filter to what needs replenishment."
      />
      <DataTable
        columns={columns}
        rows={levels.data?.items ?? []}
        rowKey={(row) => row.id}
        loading={levels.isPending}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={belowInput}
              inputMode="numeric"
              onChange={(event) => {
                setBelowInput(event.target.value);
                setPage(1);
              }}
              placeholder="Below threshold… e.g. 5"
              aria-label="Only show stock below threshold"
              className="max-w-52"
            />
            {parsedBelow !== null && (
              <p className="text-xs text-muted">
                Showing levels at or below <span className="font-semibold text-foreground">{parsedBelow}</span>
              </p>
            )}
          </div>
        }
        emptyState={
          <EmptyState
            icon={<Boxes className="size-6" aria-hidden />}
            title={parsedBelow !== null ? "Nothing below that threshold" : "No inventory synced yet"}
            body={
              parsedBelow !== null
                ? "Every tracked variant is above the threshold right now."
                : "Run a sync from Settings → Sync to pull locations and stock levels from Shopify."
            }
          />
        }
        pagination={
          levels.data !== undefined
            ? {
                page: levels.data.page,
                pageSize: levels.data.pageSize,
                totalItems: levels.data.totalItems,
                onPageChange: setPage,
              }
            : undefined
        }
      />
    </div>
  );
}
