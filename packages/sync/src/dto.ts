import { z } from "zod";

/**
 * Canonical REST payload contracts for the Shopify resources the data plane
 * replicates (P2). ONE schema per resource, shared by both ingestion paths:
 *   1. bulk sync responses (products.json, orders.json, …), and
 *   2. webhook deliveries (same REST serialization),
 * which guarantees a product written by a sync and a product written by a
 * webhook are indistinguishable downstream. `.passthrough()` keeps forward
 * compatibility when Shopify adds fields; numeric ids/money/timestamps are
 * normalized to our column representations here and nowhere else.
 */

const shopifyId = z
  .union([z.number().int(), z.string().min(1)])
  .transform((value) => String(value));

const money = z
  .union([z.string(), z.number()])
  .transform((value) => String(value));

const timestamp = z
  .string()
  .min(1)
  .transform((value) => new Date(value));

const tagsList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    Array.isArray(value)
      ? value
      : value
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
  );

const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();

// ── Products + variants ─────────────────────────────────────────────────────

export const restVariantSchema = z
  .object({
    id: shopifyId,
    product_id: shopifyId,
    sku: nullable(z.string()),
    title: nullable(z.string()),
    price: money.default("0"),
    compare_at_price: nullable(money),
    inventory_item_id: nullable(shopifyId),
    position: nullable(z.number().int()),
    barcode: nullable(z.string()),
    created_at: nullable(timestamp),
    updated_at: nullable(timestamp),
  })
  .passthrough();
export type RestVariant = z.infer<typeof restVariantSchema>;

export const restProductSchema = z
  .object({
    id: shopifyId,
    title: z.string().default(""),
    handle: nullable(z.string()),
    status: z.string().default("active"),
    vendor: nullable(z.string()),
    product_type: nullable(z.string()),
    tags: tagsList.default([]),
    body_html: nullable(z.string()),
    published_at: nullable(timestamp),
    created_at: nullable(timestamp),
    updated_at: nullable(timestamp),
    variants: z.array(restVariantSchema).default([]),
  })
  .passthrough();
export type RestProduct = z.infer<typeof restProductSchema>;

// ── Customers ───────────────────────────────────────────────────────────────

export const restCustomerSchema = z
  .object({
    id: shopifyId,
    email: nullable(z.string()),
    first_name: nullable(z.string()),
    last_name: nullable(z.string()),
    phone: nullable(z.string()),
    state: nullable(z.string()),
    orders_count: z.number().int().default(0),
    total_spent: money.default("0"),
    accepts_marketing: z.boolean().default(false),
    tags: tagsList.default([]),
    created_at: nullable(timestamp),
    updated_at: nullable(timestamp),
  })
  .passthrough();
export type RestCustomer = z.infer<typeof restCustomerSchema>;

// ── Orders + line items + refunds ────────────────────────────────────────────

export const restLineItemSchema = z
  .object({
    id: shopifyId,
    product_id: nullable(shopifyId),
    variant_id: nullable(shopifyId),
    sku: nullable(z.string()),
    title: nullable(z.string()),
    quantity: z.number().int().default(0),
    price: money.default("0"),
    total_discount: money.default("0"),
  })
  .passthrough();
export type RestLineItem = z.infer<typeof restLineItemSchema>;

export const restRefundTransactionSchema = z
  .object({
    id: shopifyId,
    kind: z.string().default(""),
    status: z.string().default(""),
    amount: money.default("0"),
    processed_at: nullable(timestamp),
  })
  .passthrough();

export const restRefundSchema = z
  .object({
    id: shopifyId,
    order_id: shopifyId,
    processed_at: nullable(timestamp),
    transactions: z.array(restRefundTransactionSchema).default([]),
  })
  .passthrough();

export const restOrderSchema = z
  .object({
    id: shopifyId,
    name: z.string().default(""),
    order_number: nullable(z.number().int()),
    email: nullable(z.string()),
    financial_status: nullable(z.string()),
    fulfillment_status: nullable(z.string()),
    currency: z.string().default("USD"),
    subtotal_price: money.default("0"),
    total_discounts: money.default("0"),
    total_tax: money.default("0"),
    total_price: money.default("0"),
    total_shipping_price_set: z
      .object({ shop_money: z.object({ amount: money }) })
      .nullable()
      .optional(),
    processed_at: nullable(timestamp),
    closed_at: nullable(timestamp),
    cancelled_at: nullable(timestamp),
    cancel_reason: nullable(z.string()),
    test: z.boolean().default(false),
    tags: tagsList.default([]),
    created_at: nullable(timestamp),
    updated_at: nullable(timestamp),
    customer: z.object({ id: shopifyId }).passthrough().nullable().optional(),
    line_items: z.array(restLineItemSchema).default([]),
    refunds: z.array(restRefundSchema).default([]),
    /** M4 (additive): checkout linkage + discount attribution inputs. */
    checkout_token: nullable(z.string()),
    discount_codes: z
      .array(
        z
          .object({ code: z.string(), amount: z.union([z.string(), z.number()]).optional(), type: z.string().optional() })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type RestOrder = z.infer<typeof restOrderSchema>;

// ── Checkouts (M4: the abandoned-cart data plane) ───────────────────────────

export const restCheckoutLineItemSchema = z
  .object({
    title: nullable(z.string()),
    quantity: z.number().int().default(1),
    price: money.default("0"),
    product_id: shopifyId.nullable().optional(),
    variant_id: shopifyId.nullable().optional(),
  })
  .passthrough();

export const restCheckoutSchema = z
  .object({
    id: shopifyId,
    token: z.string().min(1),
    email: nullable(z.string()),
    currency: z.string().default("USD"),
    total_price: money.default("0"),
    /** Recovery URL: REST names it abandoned_checkout_url; some payloads carry web_url. */
    abandoned_checkout_url: nullable(z.string()),
    web_url: nullable(z.string()),
    completed_at: nullable(timestamp),
    closed_at: nullable(timestamp),
    customer: z.object({ id: shopifyId }).passthrough().nullable().optional(),
    line_items: z.array(restCheckoutLineItemSchema).default([]),
    created_at: nullable(timestamp),
    updated_at: nullable(timestamp),
  })
  .passthrough();
export type RestCheckout = z.infer<typeof restCheckoutSchema>;

// ── Locations + inventory levels ─────────────────────────────────────────────

export const restLocationSchema = z
  .object({
    id: shopifyId,
    name: z.string().default(""),
    active: z.boolean().default(true),
  })
  .passthrough();
export type RestLocation = z.infer<typeof restLocationSchema>;

export const restInventoryLevelSchema = z
  .object({
    inventory_item_id: shopifyId,
    location_id: shopifyId,
    available: z.number().int().nullable().default(0),
    updated_at: nullable(timestamp),
  })
  .passthrough();
export type RestInventoryLevel = z.infer<typeof restInventoryLevelSchema>;

// ── Collections ─────────────────────────────────────────────────────────────

export const restCollectionSchema = z
  .object({
    id: shopifyId,
    title: z.string().default(""),
    handle: nullable(z.string()),
    updated_at: nullable(timestamp),
  })
  .passthrough();
export type RestCollection = z.infer<typeof restCollectionSchema>;

// ── Price rules + discount codes ─────────────────────────────────────────────

export const restPriceRuleSchema = z
  .object({
    id: shopifyId,
    title: z.string().default(""),
    value_type: z.string().default("fixed_amount"),
    value: money.default("0"),
    usage_count: z.number().int().default(0),
    starts_at: nullable(timestamp),
    ends_at: nullable(timestamp),
    created_at: nullable(timestamp),
    updated_at: nullable(timestamp),
  })
  .passthrough();
export type RestPriceRule = z.infer<typeof restPriceRuleSchema>;

export const restDiscountCodeSchema = z
  .object({
    id: shopifyId,
    price_rule_id: shopifyId,
    code: z.string().default(""),
    usage_count: z.number().int().default(0),
    created_at: nullable(timestamp),
  })
  .passthrough();
export type RestDiscountCode = z.infer<typeof restDiscountCodeSchema>;

// ── Metafields (REST shape; GraphQL normalized separately) ───────────────────

export const restMetafieldSchema = z
  .object({
    id: shopifyId,
    namespace: z.string().default(""),
    key: z.string().default(""),
    type: nullable(z.string()),
    value: z.unknown(),
    updated_at: nullable(timestamp),
  })
  .passthrough();
export type RestMetafield = z.infer<typeof restMetafieldSchema>;

// ── Collection page wrappers (REST list responses) ──────────────────────────

export function pageParser<TSchema extends z.ZodTypeAny>(key: string, item: TSchema) {
  return z.object({}).passthrough().transform((body) => {
    const raw = (body as Record<string, unknown>)[key];
    return z.array(item).parse(Array.isArray(raw) ? raw : []);
  });
}
