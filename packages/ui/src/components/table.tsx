import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../cn";
import { Skeleton } from "./feedback";
import { Button } from "./primitives";

/**
 * DataTable (P9 tables: sticky headers, sorting, pagination, search-slot,
 * empty state). Rendering is controlled: data arrives paginated from the API
 * (server-side) — the table owns ZERO data semantics, only presentation +
 * interaction, so every consumer inherits identical behavior.
 */

export interface ColumnDef<TRow> {
  readonly key: string;
  readonly header: ReactNode;
  /** Set to enable the sort control for this column (controlled by consumer). */
  readonly sortable?: boolean;
  readonly align?: "left" | "right" | "center";
  readonly width?: string;
  readonly cell: (row: TRow, index: number) => ReactNode;
}

export type SortDirection = "asc" | "desc";

export interface DataTableProps<TRow> {
  readonly columns: readonly ColumnDef<TRow>[];
  readonly rows: readonly TRow[];
  readonly rowKey: (row: TRow) => string;
  readonly loading?: boolean;
  readonly emptyState?: ReactNode;
  readonly onRowClick?: ((row: TRow) => void) | undefined;
  readonly sort?: { key: string; direction: SortDirection } | undefined;
  readonly onSortChange?: ((key: string) => void) | undefined;
  readonly pagination?: {
    page: number;
    pageSize: number;
    totalItems: number;
    onPageChange: (page: number) => void;
  } | undefined;
  /** Extra toolbar slot (search input, filters). */
  readonly toolbar?: ReactNode;
  readonly className?: string;
}

const alignClass = { left: "text-left", right: "text-right", center: "text-center" } as const;

export function DataTable<TRow>(props: DataTableProps<TRow>): ReactNode {
  const {
    columns, rows, rowKey, loading = false, emptyState, onRowClick, sort, onSortChange, pagination, toolbar, className,
  } = props;
  const totalPages = pagination !== undefined ? Math.max(1, Math.ceil(pagination.totalItems / pagination.pageSize)) : 1;

  return (
    <div className={cn("overflow-hidden rounded-lg border border-subtle bg-surface-solid", className)}>
      {toolbar !== undefined && (
        <div className="flex items-center gap-3 border-b border-subtle px-4 py-3">{toolbar}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-raised">
            <tr>
              {columns.map((column) => {
                const sorted = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width !== undefined ? { width: column.width } : undefined}
                    className={cn(
                      "border-b border-subtle px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted",
                      alignClass[column.align ?? "left"],
                    )}
                    aria-sort={sorted ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {column.sortable === true && onSortChange !== undefined ? (
                      <button
                        type="button"
                        onClick={() => onSortChange(column.key)}
                        className="inline-flex items-center gap-1.5 uppercase tracking-wider transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        {column.header}
                        {sorted ? (
                          sort.direction === "asc" ? (
                            <ArrowUp className="size-3" aria-hidden />
                          ) : (
                            <ArrowDown className="size-3" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="size-3 opacity-50" aria-hidden />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={`skeleton-${String(i)}`} className="border-b border-subtle/60">
                    {columns.map((column) => (
                      <td key={column.key} className="px-4 py-3.5">
                        <Skeleton className="h-3.5 w-4/5" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row, index) => {
                  const key = rowKey(row);
                  return (
                    <tr
                      key={key}
                      onClick={onRowClick !== undefined ? () => onRowClick(row) : undefined}
                      className={cn(
                        "border-b border-subtle/60 transition-colors last:border-0",
                        onRowClick !== undefined && "cursor-pointer hover:bg-surface-raised/60",
                      )}
                      tabIndex={onRowClick !== undefined ? 0 : undefined}
                      onKeyDown={
                        onRowClick !== undefined
                          ? (event) => {
                              if (event.key === "Enter") onRowClick(row);
                            }
                          : undefined
                      }
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={cn("px-4 py-3.5 text-[13px] text-foreground/90", alignClass[column.align ?? "left"])}
                        >
                          {column.cell(row, index)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!loading && rows.length === 0 && emptyState}
      </div>
      {pagination !== undefined && pagination.totalItems > 0 && (
        <div className="flex items-center justify-between gap-4 border-t border-subtle px-4 py-3">
          <p className="text-xs text-muted">
            Page {pagination.page} of {totalPages} · {pagination.totalItems} total
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              aria-label="Previous page"
              iconLeft={<ChevronLeft className="size-3.5" aria-hidden />}
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pagination.page >= totalPages}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              aria-label="Next page"
              iconRight={<ChevronRight className="size-3.5" aria-hidden />}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── StatCard (P9 hero KPI) ─────────────────────────────────────────────── */

export function StatCard({
  label,
  value,
  icon,
  delta,
  deltaTone,
  hint,
  chart,
  loading = false,
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  delta?: ReactNode;
  deltaTone?: "up" | "down" | "neutral" | undefined;
  hint?: string | undefined;
  chart?: ReactNode;
  loading?: boolean;
  className?: string | undefined;
}): ReactNode {
  return (
    <div
      className={cn(
        "group rounded-lg border border-subtle bg-surface-solid p-5 shadow-[var(--shadow-card)]",
        "transition-all duration-[var(--transition-base)] hover:-translate-y-0.5 hover:border-strong",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
        {icon !== undefined && (
          <span className="rounded-md bg-primary-soft p-1.5 text-primary transition-transform duration-[var(--transition-base)] group-hover:scale-110">
            {icon}
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-8 w-2/3" />
      ) : (
        <p className="mt-2 text-[26px] font-semibold leading-tight tracking-tight text-foreground">{value}</p>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs">
        {delta !== undefined && (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-semibold",
              deltaTone === "up" && "text-success",
              deltaTone === "down" && "text-danger",
              (deltaTone === "neutral" || deltaTone === undefined) && "text-muted",
            )}
          >
            {delta}
          </span>
        )}
        {hint !== undefined && <span className="text-faint">{hint}</span>}
      </div>
      {chart !== undefined && <div className="mt-3">{chart}</div>}
    </div>
  );
}
