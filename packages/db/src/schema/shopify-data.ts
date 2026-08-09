import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { CollectionType, MetafieldOwnerType, ProductStatus } from "@profit/types";
import { baseColumns, enumToPgTuple, softDeleteColumns } from "./_common";
import { stores } from "./merchant";

/**
 * Shopify data plane (PART 2): the normalized, tenant-scoped replica of each
 * store's Shopify objects. Identity rule across ALL tables: Shopify's numeric
 * id is the natural key, stored as varchar and unique per store
 * (uniqueIndex(storeId, shopify*Id)) so both the sync engine and webhook
 * appliers upsert idempotently against the same constraint.
 *
 * Money columns are numeric(14,2) exact decimals returned by drizzle as
 * strings — arithmetic happens in SQL/cents, never in float JS.
 * `shopify_created_at`/`shopify_updated_at` preserve Shopify-side timestamps;
 * baseColumns.createdAt/updatedAt are OUR row lifecycle.
 */

export const productStatusEnum = pgEnum("product_status", enumToPgTuple(ProductStatus));
export const collectionTypeEnum = pgEnum("collection_type", enumToPgTuple(CollectionType));
export const metafieldOwnerTypeEnum = pgEnum(
  "metafield_owner_type",
  enumToPgTuple(MetafieldOwnerType),
);

export const shopifyProducts = pgTable(
  "shopify_products",
  {
    ...baseColumns,
    ...softDeleteColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    shopifyProductId: varchar("shopify_product_id", { length: 64 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    handle: varchar("handle", { length: 255 }),
    status: productStatusEnum("status").notNull().default("ACTIVE"),
    vendor: varchar("vendor", { length: 255 }),
    productType: varchar("product_type", { length: 255 }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    bodyHtml: text("body_html"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    shopifyCreatedAt: timestamp("shopify_created_at", { withTimezone: true, mode: "date" }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_products_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyProductId,
    ),
    index("shopify_products_store_status_idx").on(table.storeId, table.status),
  ],
);

export const shopifyProductVariants = pgTable(
  "shopify_product_variants",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => shopifyProducts.id, { onDelete: "cascade" }),
    shopifyVariantId: varchar("shopify_variant_id", { length: 64 }).notNull(),
    /** Join key to shopify_inventory_levels.inventory_item_id. */
    inventoryItemId: varchar("inventory_item_id", { length: 64 }),
    sku: varchar("sku", { length: 255 }),
    title: varchar("title", { length: 512 }),
    price: numeric("price", { precision: 14, scale: 2 }).notNull().default("0"),
    compareAtPrice: numeric("compare_at_price", { precision: 14, scale: 2 }),
    position: integer("position"),
    barcode: varchar("barcode", { length: 255 }),
    shopifyCreatedAt: timestamp("shopify_created_at", { withTimezone: true, mode: "date" }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_product_variants_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyVariantId,
    ),
    index("shopify_product_variants_store_product_idx").on(table.storeId, table.productId),
    index("shopify_product_variants_store_inventory_item_idx").on(
      table.storeId,
      table.inventoryItemId,
    ),
  ],
);

export const shopifyCustomers = pgTable(
  "shopify_customers",
  {
    ...baseColumns,
    ...softDeleteColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    shopifyCustomerId: varchar("shopify_customer_id", { length: 64 }).notNull(),
    email: varchar("email", { length: 320 }),
    firstName: varchar("first_name", { length: 255 }),
    lastName: varchar("last_name", { length: 255 }),
    phone: varchar("phone", { length: 64 }),
    state: varchar("state", { length: 32 }),
    ordersCount: integer("orders_count").notNull().default(0),
    totalSpent: numeric("total_spent", { precision: 14, scale: 2 }).notNull().default("0"),
    acceptsMarketing: boolean("accepts_marketing").notNull().default(false),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    shopifyCreatedAt: timestamp("shopify_created_at", { withTimezone: true, mode: "date" }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_customers_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyCustomerId,
    ),
    index("shopify_customers_store_email_idx").on(table.storeId, table.email),
  ],
);

export const shopifyOrders = pgTable(
  "shopify_orders",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    shopifyOrderId: varchar("shopify_order_id", { length: 64 }).notNull(),
    customerId: uuid("customer_id").references(() => shopifyCustomers.id, {
      onDelete: "set null",
    }),
    /** Display number "#1024" and the numeric order_number. */
    name: varchar("name", { length: 64 }).notNull().default(""),
    orderNumber: integer("order_number"),
    email: varchar("email", { length: 320 }),
    financialStatus: varchar("financial_status", { length: 64 }),
    fulfillmentStatus: varchar("fulfillment_status", { length: 64 }),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    subtotalPrice: numeric("subtotal_price", { precision: 14, scale: 2 }).notNull().default("0"),
    totalDiscounts: numeric("total_discounts", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    totalTax: numeric("total_tax", { precision: 14, scale: 2 }).notNull().default("0"),
    totalShipping: numeric("total_shipping", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    totalPrice: numeric("total_price", { precision: 14, scale: 2 }).notNull().default("0"),
    totalRefunded: numeric("total_refunded", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    cancelReason: varchar("cancel_reason", { length: 255 }),
    isTest: boolean("is_test").notNull().default(false),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** M4 (additive): links the order back to its checkout for cart-recovery attribution. */
    checkoutToken: varchar("checkout_token", { length: 128 }),
    /** M4 (additive): [{ code, type }] as returned by Shopify — discount attribution input. */
    discountCodes: jsonb("discount_codes").notNull().default(sql`'[]'::jsonb`),
    shopifyCreatedAt: timestamp("shopify_created_at", { withTimezone: true, mode: "date" }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_orders_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyOrderId,
    ),
    index("shopify_orders_store_processed_idx").on(table.storeId, table.processedAt),
    index("shopify_orders_store_customer_idx").on(table.storeId, table.customerId),
  ],
);

export const shopifyOrderLineItems = pgTable(
  "shopify_order_line_items",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => shopifyOrders.id, { onDelete: "cascade" }),
    shopifyLineItemId: varchar("shopify_line_item_id", { length: 64 }).notNull(),
    productId: uuid("product_id").references(() => shopifyProducts.id, {
      onDelete: "set null",
    }),
    variantId: uuid("variant_id").references(() => shopifyProductVariants.id, {
      onDelete: "set null",
    }),
    sku: varchar("sku", { length: 255 }),
    title: varchar("title", { length: 512 }),
    quantity: integer("quantity").notNull().default(0),
    price: numeric("price", { precision: 14, scale: 2 }).notNull().default("0"),
    totalDiscount: numeric("total_discount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
  },
  (table) => [
    uniqueIndex("shopify_order_line_items_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyLineItemId,
    ),
    index("shopify_order_line_items_store_order_idx").on(table.storeId, table.orderId),
    index("shopify_order_line_items_store_product_idx").on(table.storeId, table.productId),
  ],
);

export const shopifyLocations = pgTable(
  "shopify_locations",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    shopifyLocationId: varchar("shopify_location_id", { length: 64 }).notNull(),
    name: varchar("name", { length: 512 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (table) => [
    uniqueIndex("shopify_locations_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyLocationId,
    ),
  ],
);

export const shopifyInventoryLevels = pgTable(
  "shopify_inventory_levels",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    inventoryItemId: varchar("inventory_item_id", { length: 64 }).notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => shopifyLocations.id, { onDelete: "cascade" }),
    available: integer("available").notNull().default(0),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_inventory_levels_store_item_location_unique").on(
      table.storeId,
      table.inventoryItemId,
      table.locationId,
    ),
    index("shopify_inventory_levels_store_item_idx").on(table.storeId, table.inventoryItemId),
  ],
);

export const shopifyCollections = pgTable(
  "shopify_collections",
  {
    ...baseColumns,
    ...softDeleteColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    shopifyCollectionId: varchar("shopify_collection_id", { length: 64 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    handle: varchar("handle", { length: 255 }),
    collectionType: collectionTypeEnum("collection_type").notNull(),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_collections_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyCollectionId,
    ),
  ],
);

export const shopifyPriceRules = pgTable(
  "shopify_price_rules",
  {
    ...baseColumns,
    ...softDeleteColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    shopifyPriceRuleId: varchar("shopify_price_rule_id", { length: 64 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    /** "fixed_amount" | "percentage" — Shopify vocabulary, kept as text. */
    valueType: varchar("value_type", { length: 32 }).notNull(),
    value: numeric("value", { precision: 14, scale: 2 }).notNull().default("0"),
    usageCount: integer("usage_count").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }),
    shopifyCreatedAt: timestamp("shopify_created_at", { withTimezone: true, mode: "date" }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_price_rules_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyPriceRuleId,
    ),
  ],
);

export const shopifyDiscountCodes = pgTable(
  "shopify_discount_codes",
  {
    ...baseColumns,
    ...softDeleteColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    priceRuleId: uuid("price_rule_id")
      .notNull()
      .references(() => shopifyPriceRules.id, { onDelete: "cascade" }),
    shopifyDiscountCodeId: varchar("shopify_discount_code_id", { length: 64 }).notNull(),
    code: varchar("code", { length: 255 }).notNull(),
    usageCount: integer("usage_count").notNull().default(0),
    shopifyCreatedAt: timestamp("shopify_created_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_discount_codes_store_shopify_id_unique").on(
      table.storeId,
      table.shopifyDiscountCodeId,
    ),
    index("shopify_discount_codes_store_rule_idx").on(table.storeId, table.priceRuleId),
  ],
);

/**
 * Abandoned-checkout data plane (M4). The `token` is Shopify's stable
 * identity and the attribution join key: orders created from a checkout carry
 * the same token in shopify_orders.checkout_token. "Abandoned" is a computed
 * state (created before the recovery horizon, completed_at NULL, no linked
 * order) — never a mutable flag, so stale rows can't lie.
 */
export const shopifyCheckouts = pgTable(
  "shopify_checkouts",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    shopifyCheckoutId: varchar("shopify_checkout_id", { length: 64 }).notNull(),
    token: varchar("token", { length: 128 }).notNull(),
    email: varchar("email", { length: 320 }),
    customerId: uuid("customer_id").references(() => shopifyCustomers.id, {
      onDelete: "set null",
    }),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    totalPrice: numeric("total_price", { precision: 14, scale: 2 }).notNull().default("0"),
    /** Recovery URL Shopify generates (abandoned_checkout_url). */
    webUrl: varchar("web_url", { length: 1024 }),
    /** [{ title, quantity, priceCents?, productId? }] — compact render context for emails. */
    lineItems: jsonb("line_items").notNull().default(sql`'[]'::jsonb`),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    shopifyCreatedAt: timestamp("shopify_created_at", { withTimezone: true, mode: "date" }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_checkouts_store_token_unique").on(table.storeId, table.token),
    index("shopify_checkouts_store_created_idx").on(table.storeId, table.shopifyCreatedAt),
  ],
);

export const shopifyMetafields = pgTable(
  "shopify_metafields",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    ownerType: metafieldOwnerTypeEnum("owner_type").notNull(),
    /** Shopify numeric id of the owning resource (product/customer/…/shop domain). */
    ownerShopifyId: varchar("owner_shopify_id", { length: 128 }).notNull(),
    namespace: varchar("namespace", { length: 255 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    valueType: varchar("value_type", { length: 128 }),
    value: jsonb("value"),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("shopify_metafields_owner_key_unique").on(
      table.storeId,
      table.ownerType,
      table.ownerShopifyId,
      table.namespace,
      table.key,
    ),
    index("shopify_metafields_store_owner_idx").on(table.storeId, table.ownerType),
  ],
);
