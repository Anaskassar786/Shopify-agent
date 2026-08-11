import { GraphqlPaginator, RestThrottle, ShopifyPaginator, type ShopifyAdminContext } from "@profit/shopify";
import { SyncMode, SyncModule } from "@profit/types";
import { CollectionType, MetafieldOwnerType } from "@profit/types";
import {
  pageParser,
  restCheckoutSchema,
  restCollectionSchema,
  restCustomerSchema,
  restDiscountCodeSchema,
  restInventoryLevelSchema,
  restLocationSchema,
  restMetafieldSchema,
  restOrderSchema,
  restPriceRuleSchema,
  restProductSchema,
} from "../dto";
import {
  mergeStats,
  upsertCheckouts,
  upsertCollections,
  upsertCustomers,
  upsertDiscountCodes,
  upsertInventoryLevels,
  upsertLocations,
  upsertMetafields,
  upsertOrders,
  upsertPriceRules,
  upsertProducts,
  type MetafieldUpsertInput,
} from "../writers";
import type { SyncModuleContext, SyncModuleImpl } from "./types";

/**
 * The seven sync modules (P2). Rules all of them follow:
 *  - wall-clock time never leaks into payloads: incremental runs filter with
 *    `updated_at_min` where Shopify supports it, otherwise run full (honest
 *    docs beat silent staleness);
 *  - every finished page checkpoints (cursor + accumulated stats);
 *  - module ordering for full runs lives in full-sync.ts (products before
 *    orders so line-item FKs resolve; locations before inventory levels).
 */

function restClient(ctx: SyncModuleContext): ShopifyPaginator {
  const adminCtx: ShopifyAdminContext = {
    shopDomain: ctx.shopDomain,
    accessToken: ctx.accessToken,
    apiVersion: ctx.apiVersion,
    ...(ctx.refreshAccessToken ? { refreshAccessToken: ctx.refreshAccessToken } : {}),
  };
  return new ShopifyPaginator(adminCtx, new RestThrottle({}));
}

function pageOptions(ctx: SyncModuleContext): Parameters<ShopifyPaginator["paginate"]>[3] {
  return ctx.httpOptions ?? {};
}

function incrementalParams(
  ctx: SyncModuleContext,
): Record<string, string> {
  // Incremental runs filter server-side by the last completed run; the caller
  // supplies the watermark via mode + stored finishedAt (see worker handler).
  return ctx.mode === SyncMode.Incremental && ctx.lastIncrementalWatermark !== null
    ? { updated_at_min: ctx.lastIncrementalWatermark.toISOString() }
    : {};
}

const productsModule: SyncModuleImpl = {
  id: SyncModule.Products,
  async sync(ctx) {
    const paginator = restClient(ctx);
    for await (const page of paginator.paginate<unknown>(
      "products",
      { status: "any", ...incrementalParams(ctx) },
      ctx.resumeCursor,
      pageOptions(ctx),
    )) {
      const products = pageParser("products", restProductSchema).parse(page.body);
      const stats = await upsertProducts(ctx.db, ctx.storeId, products);
      await ctx.checkpoint.pageComplete(page.nextPageInfo, stats);
    }
  },
};

const customersModule: SyncModuleImpl = {
  id: SyncModule.Customers,
  async sync(ctx) {
    const paginator = restClient(ctx);
    for await (const page of paginator.paginate<unknown>(
      "customers",
      { ...incrementalParams(ctx) },
      ctx.resumeCursor,
      pageOptions(ctx),
    )) {
      const customers = pageParser("customers", restCustomerSchema).parse(page.body);
      const stats = await upsertCustomers(ctx.db, ctx.storeId, customers);
      await ctx.checkpoint.pageComplete(page.nextPageInfo, stats);
    }
  },
};

const ordersModule: SyncModuleImpl = {
  id: SyncModule.Orders,
  async sync(ctx) {
    const paginator = restClient(ctx);
    for await (const page of paginator.paginate<unknown>(
      "orders",
      { status: "any", ...incrementalParams(ctx) },
      ctx.resumeCursor,
      pageOptions(ctx),
    )) {
      const orders = pageParser("orders", restOrderSchema).parse(page.body);
      const { analyticDates: _dates, ...stats } = await upsertOrders(
        ctx.db,
        ctx.storeId,
        orders,
      );
      await ctx.checkpoint.pageComplete(page.nextPageInfo, stats);
    }
  },
};

const inventoryModule: SyncModuleImpl = {
  id: SyncModule.Inventory,
  async sync(ctx) {
    const paginator = restClient(ctx);
    // 1. Locations first — levels resolve their UUID FK against this table.
    const locationsParser = pageParser("locations", restLocationSchema);
    const locations: ReturnType<typeof locationsParser.parse> = [];
    for await (const page of paginator.paginate<unknown>(
      "locations",
      {},
      // Locations are a small set, but the checkpoint contract is uniform:
      // levels resume via the stored cursor on the levels pass below.
      null,
      pageOptions(ctx),
    )) {
      locations.push(...locationsParser.parse(page.body));
    }
    const merged = mergeStats(
      { processed: 0, created: 0, updated: 0, failed: 0 },
      await upsertLocations(ctx.db, ctx.storeId, locations),
    );
    await ctx.checkpoint.pageComplete(ctx.resumeCursor, { ...merged });

    // 2. Inventory levels per location id set (Shopify requires the filter).
    const activeLocationIds = locations.map((location) => location.id);
    if (activeLocationIds.length === 0) return;
    for (let i = 0; i < activeLocationIds.length; i += 50) {
      const chunk = activeLocationIds.slice(i, i + 50);
      for await (const page of paginator.paginate<unknown>(
        "inventory_levels",
        { location_ids: chunk.join(",") },
        i === 0 ? ctx.resumeCursor : null,
        pageOptions(ctx),
      )) {
        const levels = pageParser("inventory_levels", restInventoryLevelSchema).parse(page.body);
        const { skipped, ...stats } = await upsertInventoryLevels(ctx.db, ctx.storeId, levels);
        if (skipped > 0) {
          ctx.logger.warn({ skipped }, "inventory.levels.skipped_unknown_location");
        }
        await ctx.checkpoint.pageComplete(page.nextPageInfo, stats);
      }
    }
  },
};

const collectionsModule: SyncModuleImpl = {
  id: SyncModule.Collections,
  async sync(ctx) {
    const paginator = restClient(ctx);
    // Shopify serves custom and smart collections from separate endpoints.
    for (const [endpoint, type] of [
      ["custom_collections", CollectionType.Custom],
      ["smart_collections", CollectionType.Smart],
    ] as const) {
      for await (const page of paginator.paginate<unknown>(
        endpoint,
        { ...incrementalParams(ctx) },
        ctx.resumeCursor,
        pageOptions(ctx),
      )) {
        const key = endpoint; // response wrapper key mirrors the endpoint name
        const collections = pageParser(key, restCollectionSchema).parse(page.body);
        const stats = await upsertCollections(ctx.db, ctx.storeId, collections, type);
        await ctx.checkpoint.pageComplete(page.nextPageInfo, stats);
      }
    }
  },
};

const discountsModule: SyncModuleImpl = {
  id: SyncModule.Discounts,
  async sync(ctx) {
    const paginator = restClient(ctx);
    for await (const page of paginator.paginate<unknown>(
      "price_rules",
      { ...incrementalParams(ctx) },
      ctx.resumeCursor,
      pageOptions(ctx),
    )) {
      const rules = pageParser("price_rules", restPriceRuleSchema).parse(page.body);
      const ruleStats = await upsertPriceRules(ctx.db, ctx.storeId, rules);
      // Discount codes hang off each rule (Shopify's two-level model).
      for (const rule of rules) {
        for await (const codePage of paginator.paginate<unknown>(
          `price_rules/${rule.id}/discount_codes`,
          {},
          null,
          pageOptions(ctx),
        )) {
          const codes = pageParser("discount_codes", restDiscountCodeSchema).parse(
            codePage.body,
          );
          const codeStats = await upsertDiscountCodes(ctx.db, ctx.storeId, codes);
          if (codeStats.skipped > 0) {
            ctx.logger.warn({ skipped: codeStats.skipped, rule: rule.id }, "discounts.codes.skipped");
          }
          mergeStats(ruleStats, codeStats);
        }
      }
      await ctx.checkpoint.pageComplete(page.nextPageInfo, ruleStats);
    }
  },
};

/**
 * Metafields: shop-level via REST; product-level via GraphQL (ONE query per
 * 100 products instead of one REST call per product — P5 cost discipline).
 * Customer/order/variant-level metafields are a documented M2 follow-up; the
 * uniform table already supports every owner type.
 */
const metafieldsModule: SyncModuleImpl = {
  id: SyncModule.Metafields,
  async sync(ctx) {
    const paginator = restClient(ctx);
    for await (const page of paginator.paginate<unknown>("metafields", {}, ctx.resumeCursor, pageOptions(ctx))) {
      const metafields = pageParser("metafields", restMetafieldSchema).parse(page.body);
      const inputs: MetafieldUpsertInput[] = metafields.map((metafield) => ({
        ownerType: MetafieldOwnerType.Shop,
        ownerShopifyId: ctx.shopDomain,
        namespace: metafield.namespace,
        key: metafield.key,
        valueType: metafield.type ?? null,
        value: metafield.value ?? null,
        shopifyUpdatedAt: metafield.updated_at ?? null,
      }));
      const stats = await upsertMetafields(ctx.db, ctx.storeId, inputs);
      await ctx.checkpoint.pageComplete(page.nextPageInfo, stats);
    }

    // Product metafields via GraphQL pagination (cost-aware client-side pacing).
    const graphqlCtx: ShopifyAdminContext = {
      shopDomain: ctx.shopDomain,
      accessToken: ctx.accessToken,
      apiVersion: ctx.apiVersion,
      ...(ctx.refreshAccessToken ? { refreshAccessToken: ctx.refreshAccessToken } : {}),
    };
    const graphql = new GraphqlPaginator(graphqlCtx);
    const query = `
      query ProductMetafields($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          nodes {
            legacyResourceId
            metafields(first: 100) {
              nodes { namespace key type value jsonValue }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    for await (const page of graphql.paginate<{
      nodes: Array<{
        legacyResourceId: string;
        metafields: {
          nodes: Array<{
            namespace: string;
            key: string;
            type: string;
            value: string;
            jsonValue?: unknown;
          }>;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    }>(query, "products", {}, 100, null)) {
      const inputs: MetafieldUpsertInput[] = [];
      for (const product of page.connection.nodes ?? []) {
        for (const metafield of product.metafields?.nodes ?? []) {
          inputs.push({
            ownerType: MetafieldOwnerType.Product,
            ownerShopifyId: String(product.legacyResourceId),
            namespace: metafield.namespace,
            key: metafield.key,
            valueType: metafield.type,
            value: metafield.jsonValue ?? metafield.value,
            shopifyUpdatedAt: null,
          });
        }
      }
      const stats = await upsertMetafields(ctx.db, ctx.storeId, inputs);
      await ctx.checkpoint.pageComplete(page.endCursor, stats);
    }
  },
};

/** M4: checkouts — REST supports updated_at_min, so watermark-incremental works. */
const checkoutsModule: SyncModuleImpl = {
  id: SyncModule.Checkouts,
  async sync(ctx) {
    const paginator = restClient(ctx);
    for await (const page of paginator.paginate<unknown>(
      "checkouts",
      incrementalParams(ctx),
      ctx.resumeCursor,
      pageOptions(ctx),
    )) {
      const checkouts = pageParser("checkouts", restCheckoutSchema).parse(page.body);
      const stats = await upsertCheckouts(ctx.db, ctx.storeId, checkouts);
      await ctx.checkpoint.pageComplete(page.nextPageInfo, stats);
    }
  },
};

export const SYNC_MODULES: Record<SyncModule, SyncModuleImpl> = {
  [SyncModule.Products]: productsModule,
  [SyncModule.Customers]: customersModule,
  [SyncModule.Orders]: ordersModule,
  [SyncModule.Inventory]: inventoryModule,
  [SyncModule.Collections]: collectionsModule,
  [SyncModule.Discounts]: discountsModule,
  [SyncModule.Metafields]: metafieldsModule,
  [SyncModule.Checkouts]: checkoutsModule,
};

/** Order matters: products before orders (FK resolution), locations in-module first. */
export const FULL_SYNC_ORDER: readonly SyncModule[] = [
  SyncModule.Products,
  SyncModule.Collections,
  SyncModule.Customers,
  SyncModule.Orders,
  SyncModule.Inventory,
  SyncModule.Discounts,
  SyncModule.Metafields,
  SyncModule.Checkouts,
];
