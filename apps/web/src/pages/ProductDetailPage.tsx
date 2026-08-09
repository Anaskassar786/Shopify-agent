import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Package, Tag } from "lucide-react";
import { Badge, Card, CardBody, DataTable, EmptyState, SkeletonText, type ColumnDef } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { formatDateTime, formatDecimalMoney } from "../lib/format";
import { useProductQuery, useProductVariantsQuery, useStoreQuery } from "../lib/queries";
import type { VariantRow } from "../lib/api-types";

export function ProductDetailPage(): ReactNode {
  const { id = "" } = useParams<{ id: string }>();
  const product = useProductQuery(id);
  const variants = useProductVariantsQuery(id);
  const store = useStoreQuery();
  const currency = store.data?.store.currency ?? "USD";

  const variantColumns: readonly ColumnDef<VariantRow>[] = [
    {
      key: "title",
      header: "Variant",
      cell: (row) => <span className="font-medium text-foreground">{row.title ?? "Default"}</span>,
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
      key: "price",
      header: "Price",
      align: "right",
      cell: (row) => (
        <span className="tabular-nums font-medium text-foreground">{formatDecimalMoney(row.price, currency)}</span>
      ),
    },
    {
      key: "compareAt",
      header: "Compare at",
      align: "right",
      cell: (row) =>
        row.compareAtPrice !== null ? (
          <span className="tabular-nums text-muted line-through">{formatDecimalMoney(row.compareAtPrice, currency)}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: "barcode",
      header: "Barcode",
      align: "right",
      cell: (row) => <span className="text-xs text-muted">{row.barcode ?? "—"}</span>,
    },
  ];

  return (
    <div>
      <Link
        to="/products"
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
      >
        <ArrowRight className="size-3 rotate-180" aria-hidden /> Back to products
      </Link>
      <QueryBoundary query={product} loading={<SkeletonText lines={3} />}>
        {product.data !== undefined && (
          <>
            <PageHeader
              title={product.data.title}
              subtitle={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Badge tone={product.data.status === "ACTIVE" ? "success" : product.data.status === "DRAFT" ? "neutral" : "warning"}>
                    {product.data.status}
                  </Badge>
                  {product.data.vendor !== null && <span>{product.data.vendor}</span>}
                  {product.data.productType !== null && <span>· {product.data.productType}</span>}
                  <span>· updated {formatDateTime(product.data.shopifyUpdatedAt ?? product.data.updatedAt)}</span>
                </span>
              }
            />
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardBody>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted">Details</p>
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-faint">Handle</dt>
                      <dd className="mt-0.5 truncate font-mono text-xs text-foreground">{product.data.handle ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-faint">Shopify product id</dt>
                      <dd className="mt-0.5 truncate font-mono text-xs text-foreground">{product.data.shopifyProductId}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-faint">Published</dt>
                      <dd className="mt-0.5 text-xs text-foreground">{formatDateTime(product.data.publishedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-faint">Created in Shopify</dt>
                      <dd className="mt-0.5 text-xs text-foreground">{formatDateTime(product.data.shopifyCreatedAt)}</dd>
                    </div>
                  </dl>
                  {product.data.tags.length > 0 && (
                    <div className="mt-4 flex flex-wrap items-center gap-1.5">
                      <Tag className="size-3.5 text-faint" aria-hidden />
                      {product.data.tags.map((tag) => (
                        <Badge key={tag} tone="neutral">{tag}</Badge>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted">Description</p>
                  {product.data.bodyHtml !== null && product.data.bodyHtml !== "" ? (
                    // Synced merchant-authored HTML from Shopify. Rendered
                    // inside a sandboxed container element with scripts inert
                    // by React escaping — we show it as TEXT, never injected HTML.
                    <p className="mt-3 line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                      {product.data.bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}
                    </p>
                  ) : (
                    <p className="mt-3 text-sm text-faint">No description provided in Shopify.</p>
                  )}
                </CardBody>
              </Card>
            </div>
          </>
        )}
      </QueryBoundary>

      <div className="mt-6">
        <DataTable
          columns={variantColumns}
          rows={variants.data ?? []}
          rowKey={(row) => row.id}
          loading={variants.isPending}
          emptyState={
            <EmptyState
              icon={<Package className="size-6" aria-hidden />}
              title="No variants synced"
              body="Variants appear after the catalog sync pulls this product's options from Shopify."
            />
          }
        />
      </div>
    </div>
  );
}
