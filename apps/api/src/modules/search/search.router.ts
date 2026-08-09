import { Router, type Router as ExpressRouter } from "express";
import { and, count, desc, eq, ilike, isNull, or } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  shopifyCustomers,
  shopifyOrders,
  shopifyProducts,
  withStoreScope,
} from "@profit/db";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import { requireActiveStore, requireAppAuth } from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/search (P4 Global Search: customers/products/orders; recommendations
 * + audit log domains join when their modules land — the grouped response
 * shape already reserves their slots via `groups`). Permission-scoped per
 * group: a VIEWER without orders:read receives an empty orders group with
 * `permitted: false`, never a 403 and never data.
 */

const GROUP_LIMIT = 5;
const QUERY_MIN = 2;
const QUERY_MAX = 120;

interface SearchGroup<TItem> {
  readonly permitted: boolean;
  readonly total: number;
  readonly items: readonly TItem[];
}

export interface GlobalSearchResult {
  readonly query: string;
  readonly groups: {
    readonly products: SearchGroup<{ id: string; title: string; status: string; handle: string | null }>;
    readonly customers: SearchGroup<{ id: string; email: string | null; name: string }>;
    readonly orders: SearchGroup<{ id: string; name: string; email: string | null; financialStatus: string | null }>;
  };
}

export function searchRouter(deps: { db: ProfitDb; jwt: JwtService }): ExpressRouter {
  const router = Router();

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  /** No single top-level permission: groups filter per-permission below. */
  router.get("/", async (req, res, next) => {
      try {
        if (req.appAuth === undefined) throw new Error("auth context missing after guard");
        const { storeId, permissions } = req.appAuth;
        const raw = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
        if (raw.length < QUERY_MIN || raw.length > QUERY_MAX) {
          const empty = emptyResult(raw);
          res.status(200).json(successEnvelope(getRequestContext(), empty));
          return;
        }
        const pattern = `%${raw}%`;
        const result = await withStoreScope(deps.db, storeId, async (tx) => {
          const canProducts = permissions.includes("products:read");
          const canCustomers = permissions.includes("customers:read");
          const canOrders = permissions.includes("orders:read");

          const productsPromise = canProducts
            ? Promise.all([
                tx
                  .select({
                    id: shopifyProducts.id,
                    title: shopifyProducts.title,
                    status: shopifyProducts.status,
                    handle: shopifyProducts.handle,
                  })
                  .from(shopifyProducts)
                  .where(
                    and(
                      eq(shopifyProducts.storeId, storeId),
                      isNull(shopifyProducts.deletedAt),
                      ilike(shopifyProducts.title, pattern),
                    ),
                  )
                  .orderBy(desc(shopifyProducts.shopifyUpdatedAt))
                  .limit(GROUP_LIMIT),
                tx
                  .select({ value: count() })
                  .from(shopifyProducts)
                  .where(
                    and(
                      eq(shopifyProducts.storeId, storeId),
                      isNull(shopifyProducts.deletedAt),
                      ilike(shopifyProducts.title, pattern),
                    ),
                  ),
              ])
            : null;

          const customersPromise = canCustomers
            ? Promise.all([
                tx
                  .select({
                    id: shopifyCustomers.id,
                    email: shopifyCustomers.email,
                    firstName: shopifyCustomers.firstName,
                    lastName: shopifyCustomers.lastName,
                  })
                  .from(shopifyCustomers)
                  .where(
                    and(
                      eq(shopifyCustomers.storeId, storeId),
                      isNull(shopifyCustomers.deletedAt),
                      or(
                        ilike(shopifyCustomers.email, pattern),
                        ilike(shopifyCustomers.firstName, pattern),
                        ilike(shopifyCustomers.lastName, pattern),
                      ),
                    ),
                  )
                  .orderBy(desc(shopifyCustomers.totalSpent))
                  .limit(GROUP_LIMIT),
                tx
                  .select({ value: count() })
                  .from(shopifyCustomers)
                  .where(
                    and(
                      eq(shopifyCustomers.storeId, storeId),
                      isNull(shopifyCustomers.deletedAt),
                      or(
                        ilike(shopifyCustomers.email, pattern),
                        ilike(shopifyCustomers.firstName, pattern),
                        ilike(shopifyCustomers.lastName, pattern),
                      ),
                    ),
                  ),
              ])
            : null;

          const ordersPromise = canOrders
            ? Promise.all([
                tx
                  .select({
                    id: shopifyOrders.id,
                    name: shopifyOrders.name,
                    email: shopifyOrders.email,
                    financialStatus: shopifyOrders.financialStatus,
                  })
                  .from(shopifyOrders)
                  .where(
                    and(
                      eq(shopifyOrders.storeId, storeId),
                      or(
                        ilike(shopifyOrders.name, pattern),
                        ilike(shopifyOrders.email, pattern),
                      ),
                    ),
                  )
                  .orderBy(desc(shopifyOrders.processedAt))
                  .limit(GROUP_LIMIT),
                tx
                  .select({ value: count() })
                  .from(shopifyOrders)
                  .where(
                    and(
                      eq(shopifyOrders.storeId, storeId),
                      or(
                        ilike(shopifyOrders.name, pattern),
                        ilike(shopifyOrders.email, pattern),
                      ),
                    ),
                  ),
              ])
            : null;

          const [products, customers, orders] = await Promise.all([
            productsPromise,
            customersPromise,
            ordersPromise,
          ]);

          const result: GlobalSearchResult = {
            query: raw,
            groups: {
              products:
                products === null
                  ? { permitted: false, total: 0, items: [] }
                  : {
                      permitted: true,
                      total: Number(products[1][0]?.value ?? 0),
                      items: products[0].map((row) => ({
                        id: row.id,
                        title: row.title,
                        status: row.status,
                        handle: row.handle,
                      })),
                    },
              customers:
                customers === null
                  ? { permitted: false, total: 0, items: [] }
                  : {
                      permitted: true,
                      total: Number(customers[1][0]?.value ?? 0),
                      items: customers[0].map((row) => ({
                        id: row.id,
                        email: row.email,
                        name: [row.firstName, row.lastName]
                          .filter((part): part is string => part !== null && part !== "")
                          .join(" "),
                      })),
                    },
              orders:
                orders === null
                  ? { permitted: false, total: 0, items: [] }
                  : {
                      permitted: true,
                      total: Number(orders[1][0]?.value ?? 0),
                      items: orders[0].map((row) => ({
                        id: row.id,
                        name: row.name,
                        email: row.email,
                        financialStatus: row.financialStatus,
                      })),
                    },
            },
          };
          return result;
        });

        res.status(200).json(successEnvelope(getRequestContext(), result));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

function emptyResult(query: string): GlobalSearchResult {
  return {
    query,
    groups: {
      products: { permitted: true, total: 0, items: [] },
      customers: { permitted: true, total: 0, items: [] },
      orders: { permitted: true, total: 0, items: [] },
    },
  };
}
