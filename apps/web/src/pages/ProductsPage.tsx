import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Package, Search } from "lucide-react";
import { Badge, DataTable, EmptyState, Input, type BadgeTone, type ColumnDef } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../lib/format";
import { useProductsQuery } from "../lib/queries";
import type { ProductRow } from "../lib/api-types";

const STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: "success",
  DRAFT: "neutral",
  ARCHIVED: "warning",
};

export function ProductsPage(): ReactNode {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const products = useProductsQuery(page, search);

  const columns: readonly ColumnDef<ProductRow>[] = [
    {
      key: "title",
      header: "Product",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{row.title}</p>
          <p className="truncate text-[11px] text-faint">{row.handle ?? "—"}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge>,
    },
    {
      key: "vendor",
      header: "Vendor",
      cell: (row) => <span className="text-muted">{row.vendor ?? "—"}</span>,
    },
    {
      key: "type",
      header: "Type",
      cell: (row) => <span className="text-muted">{row.productType ?? "—"}</span>,
    },
    {
      key: "tags",
      header: "Tags",
      cell: (row) =>
        row.tags.length === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <span className="text-xs text-muted">{row.tags.slice(0, 3).join(", ")}{row.tags.length > 3 ? ` +${String(row.tags.length - 3)}` : ""}</span>
        ),
    },
    {
      key: "updated",
      header: "Updated",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.shopifyUpdatedAt ?? row.updatedAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Products"
        subtitle="Your synced Shopify catalog. Row drill-down shows variants, pricing and identifiers."
      />
      <DataTable
        columns={columns}
        rows={products.data?.items ?? []}
        rowKey={(row) => row.id}
        loading={products.isPending}
        onRowClick={(row) => navigate(`/products/${row.id}`)}
        toolbar={
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search products by title…"
              aria-label="Search products"
              className="pl-9"
            />
          </div>
        }
        emptyState={
          <EmptyState
            icon={<Package className="size-6" aria-hidden />}
            title={search !== "" ? `No products match "${search}"` : "No products synced yet"}
            body={
              search !== ""
                ? "Try a different title — search matches any part of the product name."
                : "Run a catalog sync from Settings → Sync and your Shopify products will appear here."
            }
          />
        }
        pagination={
          products.data !== undefined
            ? {
                page: products.data.page,
                pageSize: products.data.pageSize,
                totalItems: products.data.totalItems,
                onPageChange: setPage,
              }
            : undefined
        }
      />
    </div>
  );
}
