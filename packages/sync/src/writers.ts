import { and, eq, inArray, notInArray, sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  shopifyCheckouts,
  shopifyCollections,
  shopifyCustomers,
  shopifyDiscountCodes,
  shopifyInventoryLevels,
  shopifyLocations,
  shopifyMetafields,
  shopifyOrderLineItems,
  shopifyOrders,
  shopifyPriceRules,
  shopifyProducts,
  shopifyProductVariants,
  withStoreScope,
} from "@profit/db";
import { MetafieldOwnerType } from "@profit/types";
import { CollectionType, ProductStatus } from "@profit/types";
import type {
  RestCheckout,
  RestCollection,
  RestCustomer,
  RestDiscountCode,
  RestInventoryLevel,
  RestLocation,
  RestOrder,
  RestPriceRule,
  RestProduct,
} from "./dto";

/**
 * Data-plane writers (P2/P12: every write idempotent). ONE upsert function per
 * entity family, used identically by bulk sync pages and webhook appliers.
 *
 * Invariants:
 *  - All mutations run inside withStoreScope() — RLS proofs every row by
 *    policy, not by programmer discipline;
 *  - upserts key on (store_id, shopify_*_id); `(xmax = 0)` distinguishes real
 *    creates from updates so sync stats are exact;
 *  - child rows that vanished upstream are removed (orders/products payload is
 *    authoritative), keeping the replica a true reflection, not an append-log.
 */

export interface WriteStats {
  processed: number;
  created: number;
  updated: number;
  failed: number;
}

export function emptyStats(): WriteStats {
  return { processed: 0, created: 0, updated: 0, failed: 0 };
}

export function mergeStats(target: WriteStats, delta: WriteStats): WriteStats {
  target.processed += delta.processed;
  target.created += delta.created;
  target.updated += delta.updated;
  target.failed += delta.failed;
  return target;
}

function toProductStatus(status: string): ProductStatus {
  switch (status.toUpperCase()) {
    case ProductStatus.Active:
      return ProductStatus.Active;
    case ProductStatus.Draft:
      return ProductStatus.Draft;
    case ProductStatus.Archived:
      return ProductStatus.Archived;
    default:
      return ProductStatus.Active;
  }
}

// ── Products + variants ─────────────────────────────────────────────────────

export async function upsertProducts(
  db: ProfitDb,
  storeId: string,
  products: readonly RestProduct[],
): Promise<WriteStats> {
  const stats = emptyStats();
  if (products.length === 0) return stats;

  await withStoreScope(db, storeId, async (tx) => {
    for (const product of products) {
      const upserted = await tx
        .insert(shopifyProducts)
        .values({
          storeId,
          shopifyProductId: product.id,
          title: product.title,
          status: toProductStatus(product.status),
          tags: product.tags,
          handle: product.handle ?? null,
          vendor: product.vendor ?? null,
          productType: product.product_type ?? null,
          bodyHtml: product.body_html ?? null,
          publishedAt: product.published_at ?? null,
          shopifyCreatedAt: product.created_at ?? null,
          shopifyUpdatedAt: product.updated_at ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopifyProducts.storeId, shopifyProducts.shopifyProductId],
          set: {
            title: product.title,
            status: toProductStatus(product.status),
            tags: product.tags,
            handle: product.handle ?? null,
            vendor: product.vendor ?? null,
            productType: product.product_type ?? null,
            bodyHtml: product.body_html ?? null,
            publishedAt: product.published_at ?? null,
            shopifyUpdatedAt: product.updated_at ?? null,
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: shopifyProducts.id,
          inserted: sql<boolean>`(xmax = 0)`,
        });
      const productRow = upserted[0];
      if (productRow === undefined) {
        stats.failed += 1;
        continue;
      }
      stats.processed += 1;
      if (productRow.inserted) stats.created += 1;
      else stats.updated += 1;

      // Variants: upsert the payload set, then remove variants that vanished.
      const payloadVariantIds: string[] = [];
      for (const variant of product.variants) {
        payloadVariantIds.push(variant.id);
        const variantRow = await tx
          .insert(shopifyProductVariants)
          .values({
            storeId,
            productId: productRow.id,
            shopifyVariantId: variant.id,
            price: variant.price,
            ...(variant.sku !== null && variant.sku !== undefined ? { sku: variant.sku } : {}),
            ...(variant.title !== null && variant.title !== undefined
              ? { title: variant.title }
              : {}),
            ...(variant.compare_at_price !== null && variant.compare_at_price !== undefined
              ? { compareAtPrice: variant.compare_at_price }
              : {}),
            ...(variant.inventory_item_id !== null && variant.inventory_item_id !== undefined
              ? { inventoryItemId: variant.inventory_item_id }
              : {}),
            ...(variant.position !== null && variant.position !== undefined
              ? { position: variant.position }
              : {}),
            ...(variant.barcode !== null && variant.barcode !== undefined
              ? { barcode: variant.barcode }
              : {}),
            ...(variant.created_at !== null && variant.created_at !== undefined
              ? { shopifyCreatedAt: variant.created_at }
              : {}),
            ...(variant.updated_at !== null && variant.updated_at !== undefined
              ? { shopifyUpdatedAt: variant.updated_at }
              : {}),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [shopifyProductVariants.storeId, shopifyProductVariants.shopifyVariantId],
            set: {
              productId: productRow.id,
              sku: variant.sku ?? null,
              title: variant.title ?? null,
              price: variant.price,
              compareAtPrice: variant.compare_at_price ?? null,
              inventoryItemId: variant.inventory_item_id ?? null,
              position: variant.position ?? null,
              barcode: variant.barcode ?? null,
              shopifyUpdatedAt: variant.updated_at ?? null,
              updatedAt: new Date(),
            },
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        if (variantRow[0]?.inserted === true) stats.created += 1;
        else if (variantRow[0] !== undefined) stats.updated += 1;
        stats.processed += 1;
      }
      if (payloadVariantIds.length > 0) {
        await tx
          .delete(shopifyProductVariants)
          .where(
            and(
              eq(shopifyProductVariants.storeId, storeId),
              eq(shopifyProductVariants.productId, productRow.id),
              notInArray(shopifyProductVariants.shopifyVariantId, payloadVariantIds),
            ),
          );
      }
    }
  });
  return stats;
}

export async function deleteProductByShopifyId(
  db: ProfitDb,
  storeId: string,
  shopifyProductId: string,
): Promise<void> {
  // Hard delete with cascades: variants go with the product; historical order
  // line items keep their data with product_id set to NULL by policy.
  await withStoreScope(db, storeId, async (tx) => {
    await tx
      .delete(shopifyProducts)
      .where(
        and(
          eq(shopifyProducts.storeId, storeId),
          eq(shopifyProducts.shopifyProductId, shopifyProductId),
        ),
      );
  });
}

// ── Customers ───────────────────────────────────────────────────────────────

export async function upsertCustomers(
  db: ProfitDb,
  storeId: string,
  customers: readonly RestCustomer[],
): Promise<WriteStats> {
  const stats = emptyStats();
  if (customers.length === 0) return stats;
  await withStoreScope(db, storeId, async (tx) => {
    for (const customer of customers) {
      const upserted = await tx
        .insert(shopifyCustomers)
        .values({
          storeId,
          shopifyCustomerId: customer.id,
          totalSpent: customer.total_spent,
          ordersCount: customer.orders_count,
          acceptsMarketing: customer.accepts_marketing,
          tags: customer.tags,
          ...(customer.email !== null && customer.email !== undefined
            ? { email: customer.email }
            : {}),
          ...(customer.first_name !== null && customer.first_name !== undefined
            ? { firstName: customer.first_name }
            : {}),
          ...(customer.last_name !== null && customer.last_name !== undefined
            ? { lastName: customer.last_name }
            : {}),
          ...(customer.phone !== null && customer.phone !== undefined
            ? { phone: customer.phone }
            : {}),
          ...(customer.state !== null && customer.state !== undefined
            ? { state: customer.state }
            : {}),
          ...(customer.created_at !== null && customer.created_at !== undefined
            ? { shopifyCreatedAt: customer.created_at }
            : {}),
          ...(customer.updated_at !== null && customer.updated_at !== undefined
            ? { shopifyUpdatedAt: customer.updated_at }
            : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopifyCustomers.storeId, shopifyCustomers.shopifyCustomerId],
          set: {
            email: customer.email ?? null,
            firstName: customer.first_name ?? null,
            lastName: customer.last_name ?? null,
            phone: customer.phone ?? null,
            state: customer.state ?? null,
            totalSpent: customer.total_spent,
            ordersCount: customer.orders_count,
            acceptsMarketing: customer.accepts_marketing,
            tags: customer.tags,
            shopifyUpdatedAt: customer.updated_at ?? null,
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (upserted[0]?.inserted === true) stats.created += 1;
      else if (upserted[0] !== undefined) stats.updated += 1;
      else stats.failed += 1;
      stats.processed += 1;
    }
  });
  return stats;
}

export async function deleteCustomerByShopifyId(
  db: ProfitDb,
  storeId: string,
  shopifyCustomerId: string,
): Promise<void> {
  // Metrics/aggregates for the removed customer cascade away; order rows keep
  // their numbers with customer_id set to NULL by policy.
  await withStoreScope(db, storeId, async (tx) => {
    await tx
      .delete(shopifyCustomers)
      .where(
        and(
          eq(shopifyCustomers.storeId, storeId),
          eq(shopifyCustomers.shopifyCustomerId, shopifyCustomerId),
        ),
      );
  });
}

// ── Orders + line items ─────────────────────────────────────────────────────

function orderTotals(order: RestOrder): { totalRefunded: string; totalShipping: string } {
  let refunded = 0;
  for (const refund of order.refunds) {
    for (const transaction of refund.transactions) {
      if (transaction.kind === "refund" && transaction.status === "success") {
        refunded += Number(transaction.amount);
      }
    }
  }
  return {
    totalRefunded: refunded.toFixed(2),
    totalShipping: order.total_shipping_price_set?.shop_money.amount ?? "0",
  };
}

export interface UpsertOrderResult extends WriteStats {
  /** Shop-side processed_at dates affected — analytics refresh targets. */
  readonly analyticDates: ReadonlySet<string>;
}

export async function upsertOrders(
  db: ProfitDb,
  storeId: string,
  orders: readonly RestOrder[],
): Promise<UpsertOrderResult> {
  const stats = emptyStats();
  const analyticDates = new Set<string>();
  if (orders.length === 0) return { ...stats, analyticDates };

  const customerShopifyIds = [
    ...new Set(
      orders
        .map((order) => order.customer?.id)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ];
  const variantShopifyIds = [
    ...new Set(
      orders.flatMap((order) =>
        order.line_items
          .map((item) => item.variant_id)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ),
  ];
  const productShopifyIds = [
    ...new Set(
      orders.flatMap((order) =>
        order.line_items
          .map((item) => item.product_id)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ),
  ];

  await withStoreScope(db, storeId, async (tx) => {
    const customerRows =
      customerShopifyIds.length > 0
        ? await tx
            .select({
              id: shopifyCustomers.id,
              shopifyCustomerId: shopifyCustomers.shopifyCustomerId,
            })
            .from(shopifyCustomers)
            .where(
              and(
                eq(shopifyCustomers.storeId, storeId),
                inArray(shopifyCustomers.shopifyCustomerId, customerShopifyIds),
              ),
            )
        : [];
    const customerMap = new Map(customerRows.map((row) => [row.shopifyCustomerId, row.id]));

    const variantRows =
      variantShopifyIds.length > 0
        ? await tx
            .select({
              id: shopifyProductVariants.id,
              shopifyVariantId: shopifyProductVariants.shopifyVariantId,
            })
            .from(shopifyProductVariants)
            .where(
              and(
                eq(shopifyProductVariants.storeId, storeId),
                inArray(shopifyProductVariants.shopifyVariantId, variantShopifyIds),
              ),
            )
        : [];
    const variantMap = new Map(variantRows.map((row) => [row.shopifyVariantId, row.id]));

    const productRows =
      productShopifyIds.length > 0
        ? await tx
            .select({
              id: shopifyProducts.id,
              shopifyProductId: shopifyProducts.shopifyProductId,
            })
            .from(shopifyProducts)
            .where(
              and(
                eq(shopifyProducts.storeId, storeId),
                inArray(shopifyProducts.shopifyProductId, productShopifyIds),
              ),
            )
        : [];
    const productMap = new Map(productRows.map((row) => [row.shopifyProductId, row.id]));

    for (const order of orders) {
      const totals = orderTotals(order);
      const customerId =
        order.customer?.id !== undefined && order.customer?.id !== null
          ? (customerMap.get(order.customer.id) ?? null)
          : null;

      const upserted = await tx
        .insert(shopifyOrders)
        .values({
          storeId,
          shopifyOrderId: order.id,
          name: order.name,
          currency: order.currency,
          subtotalPrice: order.subtotal_price,
          totalDiscounts: order.total_discounts,
          totalTax: order.total_tax,
          totalPrice: order.total_price,
          totalShipping: totals.totalShipping,
          totalRefunded: totals.totalRefunded,
          isTest: order.test,
          tags: order.tags,
          checkoutToken: order.checkout_token ?? null,
          discountCodes: order.discount_codes.map((entry) => ({ code: entry.code })),
          ...(customerId !== null ? { customerId } : {}),
          ...(order.order_number !== null && order.order_number !== undefined
            ? { orderNumber: order.order_number }
            : {}),
          ...(order.email !== null && order.email !== undefined ? { email: order.email } : {}),
          ...(order.financial_status !== null && order.financial_status !== undefined
            ? { financialStatus: order.financial_status }
            : {}),
          ...(order.fulfillment_status !== null && order.fulfillment_status !== undefined
            ? { fulfillmentStatus: order.fulfillment_status }
            : {}),
          ...(order.processed_at !== null && order.processed_at !== undefined
            ? { processedAt: order.processed_at }
            : {}),
          ...(order.closed_at !== null && order.closed_at !== undefined
            ? { closedAt: order.closed_at }
            : {}),
          ...(order.cancelled_at !== null && order.cancelled_at !== undefined
            ? { cancelledAt: order.cancelled_at }
            : {}),
          ...(order.cancel_reason !== null && order.cancel_reason !== undefined
            ? { cancelReason: order.cancel_reason }
            : {}),
          ...(order.created_at !== null && order.created_at !== undefined
            ? { shopifyCreatedAt: order.created_at }
            : {}),
          ...(order.updated_at !== null && order.updated_at !== undefined
            ? { shopifyUpdatedAt: order.updated_at }
            : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopifyOrders.storeId, shopifyOrders.shopifyOrderId],
          set: {
            customerId,
            name: order.name,
            email: order.email ?? null,
            financialStatus: order.financial_status ?? null,
            fulfillmentStatus: order.fulfillment_status ?? null,
            currency: order.currency,
            subtotalPrice: order.subtotal_price,
            totalDiscounts: order.total_discounts,
            totalTax: order.total_tax,
            totalPrice: order.total_price,
            totalShipping: totals.totalShipping,
            totalRefunded: totals.totalRefunded,
            processedAt: order.processed_at ?? null,
            closedAt: order.closed_at ?? null,
            cancelledAt: order.cancelled_at ?? null,
            cancelReason: order.cancel_reason ?? null,
            isTest: order.test,
            tags: order.tags,
            checkoutToken: order.checkout_token ?? null,
            discountCodes: order.discount_codes.map((entry) => ({ code: entry.code })),
            shopifyUpdatedAt: order.updated_at ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: shopifyOrders.id, inserted: sql<boolean>`(xmax = 0)` });

      const orderRow = upserted[0];
      if (orderRow === undefined) {
        stats.failed += 1;
        continue;
      }
      stats.processed += 1;
      if (orderRow.inserted) stats.created += 1;
      else stats.updated += 1;

      if (order.processed_at !== null && order.processed_at !== undefined) {
        analyticDates.add(order.processed_at.toISOString().slice(0, 10));
      }

      const payloadLineIds: string[] = [];
      for (const item of order.line_items) {
        payloadLineIds.push(item.id);
        const productId =
          item.product_id !== null && item.product_id !== undefined
            ? (productMap.get(item.product_id) ?? null)
            : null;
        const variantId =
          item.variant_id !== null && item.variant_id !== undefined
            ? (variantMap.get(item.variant_id) ?? null)
            : null;
        const lineRow = await tx
          .insert(shopifyOrderLineItems)
          .values({
            storeId,
            orderId: orderRow.id,
            shopifyLineItemId: item.id,
            quantity: item.quantity,
            price: item.price,
            totalDiscount: item.total_discount,
            ...(productId !== null ? { productId } : {}),
            ...(variantId !== null ? { variantId } : {}),
            ...(item.sku !== null && item.sku !== undefined ? { sku: item.sku } : {}),
            ...(item.title !== null && item.title !== undefined ? { title: item.title } : {}),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [shopifyOrderLineItems.storeId, shopifyOrderLineItems.shopifyLineItemId],
            set: {
              orderId: orderRow.id,
              productId,
              variantId,
              sku: item.sku ?? null,
              title: item.title ?? null,
              quantity: item.quantity,
              price: item.price,
              totalDiscount: item.total_discount,
              updatedAt: new Date(),
            },
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        if (lineRow[0]?.inserted === true) stats.created += 1;
        else if (lineRow[0] !== undefined) stats.updated += 1;
        stats.processed += 1;
      }
      // Removed lines disappear (payload is authoritative for the order).
      if (payloadLineIds.length > 0) {
        await tx
          .delete(shopifyOrderLineItems)
          .where(
            and(
              eq(shopifyOrderLineItems.storeId, storeId),
              eq(shopifyOrderLineItems.orderId, orderRow.id),
              notInArray(shopifyOrderLineItems.shopifyLineItemId, payloadLineIds),
            ),
          );
      }
    }
  });
  return { ...stats, analyticDates };
}

// ── Locations + inventory levels ─────────────────────────────────────────────

export async function upsertLocations(
  db: ProfitDb,
  storeId: string,
  locations: readonly RestLocation[],
): Promise<WriteStats> {
  const stats = emptyStats();
  if (locations.length === 0) return stats;
  await withStoreScope(db, storeId, async (tx) => {
    for (const location of locations) {
      const upserted = await tx
        .insert(shopifyLocations)
        .values({
          storeId,
          shopifyLocationId: location.id,
          name: location.name,
          isActive: location.active,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopifyLocations.storeId, shopifyLocations.shopifyLocationId],
          set: { name: location.name, isActive: location.active, updatedAt: new Date() },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (upserted[0]?.inserted === true) stats.created += 1;
      else if (upserted[0] !== undefined) stats.updated += 1;
      stats.processed += 1;
    }
  });
  return stats;
}

export async function upsertInventoryLevels(
  db: ProfitDb,
  storeId: string,
  levels: readonly RestInventoryLevel[],
): Promise<WriteStats & { skipped: number }> {
  const stats = emptyStats();
  let skipped = 0;
  if (levels.length === 0) return { ...stats, skipped };
  const locationShopifyIds = [...new Set(levels.map((level) => level.location_id))];
  await withStoreScope(db, storeId, async (tx) => {
    const locationRows = await tx
      .select({
        id: shopifyLocations.id,
        shopifyLocationId: shopifyLocations.shopifyLocationId,
      })
      .from(shopifyLocations)
      .where(
        and(
          eq(shopifyLocations.storeId, storeId),
          inArray(shopifyLocations.shopifyLocationId, locationShopifyIds),
        ),
      );
    const locationMap = new Map(locationRows.map((row) => [row.shopifyLocationId, row.id]));

    for (const level of levels) {
      const locationId = locationMap.get(level.location_id);
      if (locationId === undefined) {
        // Webhook outran the locations sync — the next inventory sync closes it.
        skipped += 1;
        continue;
      }
      const upserted = await tx
        .insert(shopifyInventoryLevels)
        .values({
          storeId,
          inventoryItemId: level.inventory_item_id,
          locationId,
          available: level.available ?? 0,
          ...(level.updated_at !== null && level.updated_at !== undefined
            ? { shopifyUpdatedAt: level.updated_at }
            : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            shopifyInventoryLevels.storeId,
            shopifyInventoryLevels.inventoryItemId,
            shopifyInventoryLevels.locationId,
          ],
          set: {
            available: level.available ?? 0,
            shopifyUpdatedAt: level.updated_at ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (upserted[0]?.inserted === true) stats.created += 1;
      else if (upserted[0] !== undefined) stats.updated += 1;
      stats.processed += 1;
    }
  });
  return { ...stats, skipped };
}

// ── Collections ─────────────────────────────────────────────────────────────

export async function upsertCollections(
  db: ProfitDb,
  storeId: string,
  collections: readonly RestCollection[],
  collectionType: CollectionType,
): Promise<WriteStats> {
  const stats = emptyStats();
  if (collections.length === 0) return stats;
  await withStoreScope(db, storeId, async (tx) => {
    for (const collection of collections) {
      const upserted = await tx
        .insert(shopifyCollections)
        .values({
          storeId,
          shopifyCollectionId: collection.id,
          title: collection.title,
          collectionType,
          ...(collection.handle !== null && collection.handle !== undefined
            ? { handle: collection.handle }
            : {}),
          ...(collection.updated_at !== null && collection.updated_at !== undefined
            ? { shopifyUpdatedAt: collection.updated_at }
            : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopifyCollections.storeId, shopifyCollections.shopifyCollectionId],
          set: {
            title: collection.title,
            handle: collection.handle ?? null,
            collectionType,
            shopifyUpdatedAt: collection.updated_at ?? null,
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (upserted[0]?.inserted === true) stats.created += 1;
      else if (upserted[0] !== undefined) stats.updated += 1;
      stats.processed += 1;
    }
  });
  return stats;
}

/** Returns the resolved collectionType of the deleted row (null when not found). */
export async function deleteCollectionByShopifyId(
  db: ProfitDb,
  storeId: string,
  shopifyCollectionId: string,
): Promise<void> {
  await withStoreScope(db, storeId, async (tx) => {
    await tx
      .delete(shopifyCollections)
      .where(
        and(
          eq(shopifyCollections.storeId, storeId),
          eq(shopifyCollections.shopifyCollectionId, shopifyCollectionId),
        ),
      );
  });
}

// ── Price rules + discount codes ─────────────────────────────────────────────

export async function upsertPriceRules(
  db: ProfitDb,
  storeId: string,
  rules: readonly RestPriceRule[],
): Promise<WriteStats> {
  const stats = emptyStats();
  if (rules.length === 0) return stats;
  await withStoreScope(db, storeId, async (tx) => {
    for (const rule of rules) {
      const upserted = await tx
        .insert(shopifyPriceRules)
        .values({
          storeId,
          shopifyPriceRuleId: rule.id,
          title: rule.title,
          valueType: rule.value_type,
          value: rule.value,
          usageCount: rule.usage_count,
          ...(rule.starts_at !== null && rule.starts_at !== undefined
            ? { startsAt: rule.starts_at }
            : {}),
          ...(rule.ends_at !== null && rule.ends_at !== undefined
            ? { endsAt: rule.ends_at }
            : {}),
          ...(rule.created_at !== null && rule.created_at !== undefined
            ? { shopifyCreatedAt: rule.created_at }
            : {}),
          ...(rule.updated_at !== null && rule.updated_at !== undefined
            ? { shopifyUpdatedAt: rule.updated_at }
            : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopifyPriceRules.storeId, shopifyPriceRules.shopifyPriceRuleId],
          set: {
            title: rule.title,
            valueType: rule.value_type,
            value: rule.value,
            usageCount: rule.usage_count,
            startsAt: rule.starts_at ?? null,
            endsAt: rule.ends_at ?? null,
            shopifyUpdatedAt: rule.updated_at ?? null,
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (upserted[0]?.inserted === true) stats.created += 1;
      else if (upserted[0] !== undefined) stats.updated += 1;
      stats.processed += 1;
    }
  });
  return stats;
}

export async function upsertDiscountCodes(
  db: ProfitDb,
  storeId: string,
  codes: readonly RestDiscountCode[],
): Promise<WriteStats & { skipped: number }> {
  const stats = emptyStats();
  let skipped = 0;
  if (codes.length === 0) return { ...stats, skipped };
  const ruleShopifyIds = [...new Set(codes.map((code) => code.price_rule_id))];
  await withStoreScope(db, storeId, async (tx) => {
    const ruleRows = await tx
      .select({
        id: shopifyPriceRules.id,
        shopifyPriceRuleId: shopifyPriceRules.shopifyPriceRuleId,
      })
      .from(shopifyPriceRules)
      .where(
        and(
          eq(shopifyPriceRules.storeId, storeId),
          inArray(shopifyPriceRules.shopifyPriceRuleId, ruleShopifyIds),
        ),
      );
    const ruleMap = new Map(ruleRows.map((row) => [row.shopifyPriceRuleId, row.id]));
    for (const code of codes) {
      const priceRuleId = ruleMap.get(code.price_rule_id);
      if (priceRuleId === undefined) {
        skipped += 1;
        continue;
      }
      const upserted = await tx
        .insert(shopifyDiscountCodes)
        .values({
          storeId,
          priceRuleId,
          shopifyDiscountCodeId: code.id,
          code: code.code,
          usageCount: code.usage_count,
          ...(code.created_at !== null && code.created_at !== undefined
            ? { shopifyCreatedAt: code.created_at }
            : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopifyDiscountCodes.storeId, shopifyDiscountCodes.shopifyDiscountCodeId],
          set: {
            priceRuleId,
            code: code.code,
            usageCount: code.usage_count,
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (upserted[0]?.inserted === true) stats.created += 1;
      else if (upserted[0] !== undefined) stats.updated += 1;
      stats.processed += 1;
    }
  });
  return { ...stats, skipped };
}

export async function deletePriceRuleByShopifyId(
  db: ProfitDb,
  storeId: string,
  shopifyPriceRuleId: string,
): Promise<void> {
  await withStoreScope(db, storeId, async (tx) => {
    await tx
      .delete(shopifyPriceRules)
      .where(
        and(
          eq(shopifyPriceRules.storeId, storeId),
          eq(shopifyPriceRules.shopifyPriceRuleId, shopifyPriceRuleId),
        ),
      );
  });
}

// ── Metafields ─────────────────────────────────────────────────────────────

export interface MetafieldUpsertInput {
  readonly ownerType: MetafieldOwnerType;
  readonly ownerShopifyId: string;
  readonly namespace: string;
  readonly key: string;
  readonly valueType: string | null;
  readonly value: unknown;
  readonly shopifyUpdatedAt: Date | null;
}

export async function upsertMetafields(
  db: ProfitDb,
  storeId: string,
  metafields: readonly MetafieldUpsertInput[],
): Promise<WriteStats> {
  const stats = emptyStats();
  if (metafields.length === 0) return stats;
  await withStoreScope(db, storeId, async (tx) => {
    for (const metafield of metafields) {
      const upserted = await tx
        .insert(shopifyMetafields)
        .values({
          storeId,
          ownerType: metafield.ownerType,
          ownerShopifyId: metafield.ownerShopifyId,
          namespace: metafield.namespace,
          key: metafield.key,
          value: metafield.value === undefined ? null : (metafield.value as Record<string, unknown> | unknown[] | string | number | boolean | null),
          ...(metafield.valueType !== null ? { valueType: metafield.valueType } : {}),
          ...(metafield.shopifyUpdatedAt !== null
            ? { shopifyUpdatedAt: metafield.shopifyUpdatedAt }
            : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            shopifyMetafields.storeId,
            shopifyMetafields.ownerType,
            shopifyMetafields.ownerShopifyId,
            shopifyMetafields.namespace,
            shopifyMetafields.key,
          ],
          set: {
            value: metafield.value === undefined ? null : (metafield.value as Record<string, unknown> | unknown[] | string | number | boolean | null),
            valueType: metafield.valueType,
            shopifyUpdatedAt: metafield.shopifyUpdatedAt,
            updatedAt: new Date(),
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (upserted[0]?.inserted === true) stats.created += 1;
      else if (upserted[0] !== undefined) stats.updated += 1;
      stats.processed += 1;
    }
  });
  return stats;
}

/** M4: checkouts writer — one upsert per checkout token (the identity), used
 * by both the CHECKOUTS sync module and checkouts/create|update webhooks. */
export async function upsertCheckouts(
  db: ProfitDb,
  storeId: string,
  checkouts: readonly RestCheckout[],
): Promise<WriteStats> {
  const stats = emptyStats();
  if (checkouts.length === 0) return stats;
  const customerShopifyIds = [
    ...new Set(
      checkouts
        .map((checkout) => checkout.customer?.id)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ];
  await withStoreScope(db, storeId, async (tx) => {
    const customerRows =
      customerShopifyIds.length > 0
        ? await tx
            .select({
              id: shopifyCustomers.id,
              shopifyCustomerId: shopifyCustomers.shopifyCustomerId,
            })
            .from(shopifyCustomers)
            .where(
              and(
                eq(shopifyCustomers.storeId, storeId),
                inArray(shopifyCustomers.shopifyCustomerId, customerShopifyIds),
              ),
            )
        : [];
    const customerMap = new Map(customerRows.map((row) => [row.shopifyCustomerId, row.id]));

    for (const checkout of checkouts) {
      const customerId =
        checkout.customer?.id !== undefined && checkout.customer?.id !== null
          ? (customerMap.get(checkout.customer.id) ?? null)
          : null;
      const webUrl = checkout.abandoned_checkout_url ?? checkout.web_url ?? null;
      const lineItems = checkout.line_items.slice(0, 20).map((item) => ({
        title: item.title ?? "Item",
        quantity: item.quantity,
        price: item.price,
        productId: item.product_id ?? null,
        variantId: item.variant_id ?? null,
      }));
      const upserted = await tx
        .insert(shopifyCheckouts)
        .values({
          storeId,
          shopifyCheckoutId: checkout.id,
          token: checkout.token,
          currency: checkout.currency,
          totalPrice: checkout.total_price,
          lineItems,
          ...(customerId !== null ? { customerId } : {}),
          ...(checkout.email !== null && checkout.email !== undefined
            ? { email: checkout.email }
            : {}),
          ...(webUrl !== null ? { webUrl } : {}),
          ...(checkout.completed_at !== null && checkout.completed_at !== undefined
            ? { completedAt: checkout.completed_at }
            : {}),
          ...(checkout.closed_at !== null && checkout.closed_at !== undefined
            ? { closedAt: checkout.closed_at }
            : {}),
          ...(checkout.created_at !== null && checkout.created_at !== undefined
            ? { shopifyCreatedAt: checkout.created_at }
            : {}),
          ...(checkout.updated_at !== null && checkout.updated_at !== undefined
            ? { shopifyUpdatedAt: checkout.updated_at }
            : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopifyCheckouts.storeId, shopifyCheckouts.token],
          set: {
            shopifyCheckoutId: checkout.id,
            customerId,
            email: checkout.email ?? null,
            currency: checkout.currency,
            totalPrice: checkout.total_price,
            webUrl,
            lineItems,
            completedAt: checkout.completed_at ?? null,
            closedAt: checkout.closed_at ?? null,
            shopifyUpdatedAt: checkout.updated_at ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (upserted[0]?.inserted === true) stats.created += 1;
      else if (upserted[0] !== undefined) stats.updated += 1;
      stats.processed += 1;
    }
  });
  return stats;
}
