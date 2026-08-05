import { Router, type Router as ExpressRouter } from "express";
import { and, asc, count, desc, eq, ilike, lt, or, sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  shopifyCustomers,
  shopifyInventoryLevels,
  shopifyLocations,
  shopifyOrderLineItems,
  shopifyOrders,
  shopifyProducts,
  shopifyProductVariants,
  customerMetrics,
  withStoreScope,
} from "@profit/db";
import { requireActiveStore, requireAppAuth, requirePermission } from "../../middleware/auth.middleware";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import { NotFoundError, ValidationError } from "../../lib/errors";
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/{products,customers,orders,inventory} — tenant-scoped read API over
 * the synced data plane (P2 endpoints; M3 dashboard pages consume these).
 * All queries run inside withStoreScope (RLS-pinned), paginated page/limit
 * with the envelope's PaginationMeta.
 */

export interface CatalogRouterDeps {
  readonly db: ProfitDb;
  readonly jwt: JwtService;
}

interface PageParams {
  page: number;
  pageSize: number;
}

function parsePage(query: Record<string, unknown>): PageParams {
  const page = Math.max(Number(query["page"] ?? 1) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query["limit"] ?? 25) || 25, 1), 100);
  return { page, pageSize };
}

async function paged<TItem>(
  items: TItem[],
  totalItems: number,
  { page, pageSize }: PageParams,
) {
  return {
    items,
    meta: {
      pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
    },
  };
}

// ── Products ────────────────────────────────────────────────────────────────

export function productsRouter(deps: CatalogRouterDeps): ExpressRouter {
  const router = Router();
  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("products:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const page = parsePage(req.query);
      const search = typeof req.query["q"] === "string" ? req.query["q"] : undefined;
      const result = await withStoreScope(deps.db, storeId, async (tx) => {
        const conditions = [
          eq(shopifyProducts.storeId, storeId),
          sql`${shopifyProducts.deletedAt} IS NULL`,
          ...(search !== undefined && search !== ""
            ? [ilike(shopifyProducts.title, `%${search}%`)]
            : []),
        ];
        const where = and(...conditions);
        const items = await tx
          .select()
          .from(shopifyProducts)
          .where(where)
          .orderBy(asc(shopifyProducts.title))
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize);
        const totalRows = await tx
          .select({ value: count() })
          .from(shopifyProducts)
          .where(where);
        return { items, total: totalRows[0]?.value ?? 0 };
      });
      const { items, meta } = await paged(result.items, result.total, page);
      res.status(200).json(successEnvelope(getRequestContext(), items, { meta }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/variants", requirePermission("products:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const productId = String(req.params["id"]);
      const variants = await withStoreScope(deps.db, storeId, async (tx) => {
        const product = await tx
          .select({ id: shopifyProducts.id })
          .from(shopifyProducts)
          .where(and(eq(shopifyProducts.id, productId), eq(shopifyProducts.storeId, storeId)))
          .limit(1);
        if (product[0] === undefined) throw new NotFoundError("Product", productId);
        return tx
          .select()
          .from(shopifyProductVariants)
          .where(
            and(
              eq(shopifyProductVariants.storeId, storeId),
              eq(shopifyProductVariants.productId, productId),
            ),
          )
          .orderBy(asc(shopifyProductVariants.position));
      });
      res.status(200).json(successEnvelope(getRequestContext(), variants));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// ── Customers ───────────────────────────────────────────────────────────────

export function customersRouter(deps: CatalogRouterDeps): ExpressRouter {
  const router = Router();
  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("customers:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const page = parsePage(req.query);
      const search = typeof req.query["q"] === "string" ? req.query["q"] : undefined;
      const result = await withStoreScope(deps.db, storeId, async (tx) => {
        const conditions = [
          eq(shopifyCustomers.storeId, storeId),
          sql`${shopifyCustomers.deletedAt} IS NULL`,
          ...(search !== undefined && search !== ""
            ? [
                or(
                  ilike(shopifyCustomers.email, `%${search}%`),
                  ilike(shopifyCustomers.firstName, `%${search}%`),
                  ilike(shopifyCustomers.lastName, `%${search}%`),
                ),
              ]
            : []),
        ];
        const where = and(
          ...(conditions.filter((c) => c !== undefined) as NonNullable<typeof conditions[number]>[]),
        );
        const items = await tx
          .select()
          .from(shopifyCustomers)
          .where(where)
          .orderBy(desc(shopifyCustomers.totalSpent))
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize);
        const totalRows = await tx
          .select({ value: count() })
          .from(shopifyCustomers)
          .where(where);
        return { items, total: totalRows[0]?.value ?? 0 };
      });
      const { items, meta } = await paged(result.items, result.total, page);
      res.status(200).json(successEnvelope(getRequestContext(), items, { meta }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", requirePermission("customers:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const customerId = String(req.params["id"]);
      const detail = await withStoreScope(deps.db, storeId, async (tx) => {
        const rows = await tx
          .select()
          .from(shopifyCustomers)
          .where(and(eq(shopifyCustomers.id, customerId), eq(shopifyCustomers.storeId, storeId)))
          .limit(1);
        const customer = rows[0];
        if (customer === undefined) throw new NotFoundError("Customer", customerId);
        const metrics = await tx
          .select()
          .from(customerMetrics)
          .where(
            and(eq(customerMetrics.storeId, storeId), eq(customerMetrics.customerId, customerId)),
          )
          .limit(1);
        const recentOrders = await tx
          .select()
          .from(shopifyOrders)
          .where(and(eq(shopifyOrders.storeId, storeId), eq(shopifyOrders.customerId, customerId)))
          .orderBy(desc(shopifyOrders.processedAt))
          .limit(10);
        return { customer, metrics: metrics[0] ?? null, recentOrders };
      });
      res.status(200).json(successEnvelope(getRequestContext(), detail));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// ── Orders ──────────────────────────────────────────────────────────────────

export function ordersRouter(deps: CatalogRouterDeps): ExpressRouter {
  const router = Router();
  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("orders:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const page = parsePage(req.query);
      const financial = typeof req.query["financial_status"] === "string"
        ? req.query["financial_status"]
        : undefined;
      const result = await withStoreScope(deps.db, storeId, async (tx) => {
        const conditions = [
          eq(shopifyOrders.storeId, storeId),
          ...(financial !== undefined && financial !== ""
            ? [eq(shopifyOrders.financialStatus, financial)]
            : []),
        ];
        const where = and(...conditions);
        const items = await tx
          .select()
          .from(shopifyOrders)
          .where(where)
          .orderBy(desc(shopifyOrders.processedAt))
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize);
        const totalRows = await tx.select({ value: count() }).from(shopifyOrders).where(where);
        return { items, total: totalRows[0]?.value ?? 0 };
      });
      const { items, meta } = await paged(result.items, result.total, page);
      res.status(200).json(successEnvelope(getRequestContext(), items, { meta }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", requirePermission("orders:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const orderId = String(req.params["id"]);
      const detail = await withStoreScope(deps.db, storeId, async (tx) => {
        const rows = await tx
          .select()
          .from(shopifyOrders)
          .where(and(eq(shopifyOrders.id, orderId), eq(shopifyOrders.storeId, storeId)))
          .limit(1);
        const order = rows[0];
        if (order === undefined) throw new NotFoundError("Order", orderId);
        const items = await tx
          .select()
          .from(shopifyOrderLineItems)
          .where(
            and(eq(shopifyOrderLineItems.storeId, storeId), eq(shopifyOrderLineItems.orderId, orderId)),
          );
        return { order, lineItems: items };
      });
      res.status(200).json(successEnvelope(getRequestContext(), detail));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// ── Inventory ───────────────────────────────────────────────────────────────

export function inventoryRouter(deps: CatalogRouterDeps): ExpressRouter {
  const router = Router();
  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/levels", requirePermission("inventory:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const page = parsePage(req.query);
      const lowStockRaw = req.query["below"];
      const below = lowStockRaw !== undefined ? Number(lowStockRaw) : undefined;
      if (lowStockRaw !== undefined && (!Number.isFinite(below) || (below ?? 0) < 0)) {
        throw new ValidationError("invalid below filter", [
          { code: "VALIDATION_FAILED", message: "below must be a non-negative number", field: "below" },
        ]);
      }
      const result = await withStoreScope(deps.db, storeId, async (tx) => {
        const conditions = [
          eq(shopifyInventoryLevels.storeId, storeId),
          ...(below !== undefined ? [lt(shopifyInventoryLevels.available, below)] : []),
        ];
        const where = and(...conditions);
        const items = await tx
          .select({
            level: shopifyInventoryLevels,
            locationName: shopifyLocations.name,
            sku: shopifyProductVariants.sku,
            variantTitle: shopifyProductVariants.title,
            productId: shopifyProductVariants.productId,
          })
          .from(shopifyInventoryLevels)
          .innerJoin(shopifyLocations, eq(shopifyLocations.id, shopifyInventoryLevels.locationId))
          .leftJoin(
            shopifyProductVariants,
            and(
              eq(shopifyProductVariants.storeId, storeId),
              eq(shopifyProductVariants.inventoryItemId, shopifyInventoryLevels.inventoryItemId),
            ),
          )
          .where(where)
          .orderBy(asc(shopifyInventoryLevels.available))
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize);
        const totalRows = await tx
          .select({ value: count() })
          .from(shopifyInventoryLevels)
          .where(where);
        return { items, total: totalRows[0]?.value ?? 0 };
      });
      const { items, meta } = await paged(result.items, result.total, page);
      res.status(200).json(successEnvelope(getRequestContext(), items, { meta }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
