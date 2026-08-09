CREATE TYPE "public"."collection_type" AS ENUM('CUSTOM', 'SMART');--> statement-breakpoint
CREATE TYPE "public"."metafield_owner_type" AS ENUM('SHOP', 'PRODUCT', 'PRODUCT_VARIANT', 'COLLECTION', 'CUSTOMER', 'ORDER');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('ACTIVE', 'DRAFT', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "shopify_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"store_id" uuid NOT NULL,
	"shopify_collection_id" varchar(64) NOT NULL,
	"title" varchar(512) NOT NULL,
	"handle" varchar(255),
	"collection_type" "collection_type" NOT NULL,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"store_id" uuid NOT NULL,
	"shopify_customer_id" varchar(64) NOT NULL,
	"email" varchar(320),
	"first_name" varchar(255),
	"last_name" varchar(255),
	"phone" varchar(64),
	"state" varchar(32),
	"orders_count" integer DEFAULT 0 NOT NULL,
	"total_spent" numeric(14, 2) DEFAULT '0' NOT NULL,
	"accepts_marketing" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"shopify_created_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_discount_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"store_id" uuid NOT NULL,
	"price_rule_id" uuid NOT NULL,
	"shopify_discount_code_id" varchar(64) NOT NULL,
	"code" varchar(255) NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"shopify_created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_inventory_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"inventory_item_id" varchar(64) NOT NULL,
	"location_id" uuid NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_location_id" varchar(64) NOT NULL,
	"name" varchar(512) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_metafields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"owner_type" "metafield_owner_type" NOT NULL,
	"owner_shopify_id" varchar(128) NOT NULL,
	"namespace" varchar(255) NOT NULL,
	"key" varchar(255) NOT NULL,
	"value_type" varchar(128),
	"value" jsonb,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_order_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_line_item_id" varchar(64) NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"sku" varchar(255),
	"title" varchar(512),
	"quantity" integer DEFAULT 0 NOT NULL,
	"price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_discount" numeric(14, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_order_id" varchar(64) NOT NULL,
	"customer_id" uuid,
	"name" varchar(64) DEFAULT '' NOT NULL,
	"order_number" integer,
	"email" varchar(320),
	"financial_status" varchar(64),
	"fulfillment_status" varchar(64),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"subtotal_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_discounts" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_tax" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_shipping" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_refunded" numeric(14, 2) DEFAULT '0' NOT NULL,
	"processed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" varchar(255),
	"is_test" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"shopify_created_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_price_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"store_id" uuid NOT NULL,
	"shopify_price_rule_id" varchar(64) NOT NULL,
	"title" varchar(512) NOT NULL,
	"value_type" varchar(32) NOT NULL,
	"value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"shopify_created_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"shopify_variant_id" varchar(64) NOT NULL,
	"inventory_item_id" varchar(64),
	"sku" varchar(255),
	"title" varchar(512),
	"price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"compare_at_price" numeric(14, 2),
	"position" integer,
	"barcode" varchar(255),
	"shopify_created_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"store_id" uuid NOT NULL,
	"shopify_product_id" varchar(64) NOT NULL,
	"title" varchar(512) NOT NULL,
	"handle" varchar(255),
	"status" "product_status" DEFAULT 'ACTIVE' NOT NULL,
	"vendor" varchar(255),
	"product_type" varchar(255),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"body_html" text,
	"published_at" timestamp with time zone,
	"shopify_created_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"total_spent_cents" bigint DEFAULT 0 NOT NULL,
	"aov_cents" integer DEFAULT 0 NOT NULL,
	"first_order_at" timestamp with time zone,
	"last_order_at" timestamp with time zone,
	"last_computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"cancelled_orders" integer DEFAULT 0 NOT NULL,
	"items_sold" integer DEFAULT 0 NOT NULL,
	"new_customers" integer DEFAULT 0 NOT NULL,
	"returning_customers" integer DEFAULT 0 NOT NULL,
	"aov_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"units_sold" integer DEFAULT 0 NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"revenue_cents" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"gross_sales_cents" bigint DEFAULT 0 NOT NULL,
	"discounts_cents" bigint DEFAULT 0 NOT NULL,
	"refunds_cents" bigint DEFAULT 0 NOT NULL,
	"net_sales_cents" bigint DEFAULT 0 NOT NULL,
	"taxes_cents" bigint DEFAULT 0 NOT NULL,
	"shipping_cents" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_history" ADD COLUMN "run_group_id" uuid;--> statement-breakpoint
ALTER TABLE "shopify_collections" ADD CONSTRAINT "shopify_collections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_customers" ADD CONSTRAINT "shopify_customers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_discount_codes" ADD CONSTRAINT "shopify_discount_codes_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_discount_codes" ADD CONSTRAINT "shopify_discount_codes_price_rule_id_shopify_price_rules_id_fk" FOREIGN KEY ("price_rule_id") REFERENCES "public"."shopify_price_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_inventory_levels" ADD CONSTRAINT "shopify_inventory_levels_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_inventory_levels" ADD CONSTRAINT "shopify_inventory_levels_location_id_shopify_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."shopify_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_locations" ADD CONSTRAINT "shopify_locations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_metafields" ADD CONSTRAINT "shopify_metafields_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order_line_items" ADD CONSTRAINT "shopify_order_line_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order_line_items" ADD CONSTRAINT "shopify_order_line_items_order_id_shopify_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shopify_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order_line_items" ADD CONSTRAINT "shopify_order_line_items_product_id_shopify_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shopify_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order_line_items" ADD CONSTRAINT "shopify_order_line_items_variant_id_shopify_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shopify_product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD CONSTRAINT "shopify_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD CONSTRAINT "shopify_orders_customer_id_shopify_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."shopify_customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_price_rules" ADD CONSTRAINT "shopify_price_rules_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_product_variants" ADD CONSTRAINT "shopify_product_variants_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_product_variants" ADD CONSTRAINT "shopify_product_variants_product_id_shopify_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shopify_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_products" ADD CONSTRAINT "shopify_products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_metrics" ADD CONSTRAINT "customer_metrics_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_metrics" ADD CONSTRAINT "customer_metrics_customer_id_shopify_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."shopify_customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_metrics" ADD CONSTRAINT "product_metrics_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_metrics" ADD CONSTRAINT "product_metrics_product_id_shopify_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shopify_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_metrics" ADD CONSTRAINT "revenue_metrics_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_collections_store_shopify_id_unique" ON "shopify_collections" USING btree ("store_id","shopify_collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_customers_store_shopify_id_unique" ON "shopify_customers" USING btree ("store_id","shopify_customer_id");--> statement-breakpoint
CREATE INDEX "shopify_customers_store_email_idx" ON "shopify_customers" USING btree ("store_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_discount_codes_store_shopify_id_unique" ON "shopify_discount_codes" USING btree ("store_id","shopify_discount_code_id");--> statement-breakpoint
CREATE INDEX "shopify_discount_codes_store_rule_idx" ON "shopify_discount_codes" USING btree ("store_id","price_rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_inventory_levels_store_item_location_unique" ON "shopify_inventory_levels" USING btree ("store_id","inventory_item_id","location_id");--> statement-breakpoint
CREATE INDEX "shopify_inventory_levels_store_item_idx" ON "shopify_inventory_levels" USING btree ("store_id","inventory_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_locations_store_shopify_id_unique" ON "shopify_locations" USING btree ("store_id","shopify_location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_metafields_owner_key_unique" ON "shopify_metafields" USING btree ("store_id","owner_type","owner_shopify_id","namespace","key");--> statement-breakpoint
CREATE INDEX "shopify_metafields_store_owner_idx" ON "shopify_metafields" USING btree ("store_id","owner_type");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_order_line_items_store_shopify_id_unique" ON "shopify_order_line_items" USING btree ("store_id","shopify_line_item_id");--> statement-breakpoint
CREATE INDEX "shopify_order_line_items_store_order_idx" ON "shopify_order_line_items" USING btree ("store_id","order_id");--> statement-breakpoint
CREATE INDEX "shopify_order_line_items_store_product_idx" ON "shopify_order_line_items" USING btree ("store_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_orders_store_shopify_id_unique" ON "shopify_orders" USING btree ("store_id","shopify_order_id");--> statement-breakpoint
CREATE INDEX "shopify_orders_store_processed_idx" ON "shopify_orders" USING btree ("store_id","processed_at");--> statement-breakpoint
CREATE INDEX "shopify_orders_store_customer_idx" ON "shopify_orders" USING btree ("store_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_price_rules_store_shopify_id_unique" ON "shopify_price_rules" USING btree ("store_id","shopify_price_rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_product_variants_store_shopify_id_unique" ON "shopify_product_variants" USING btree ("store_id","shopify_variant_id");--> statement-breakpoint
CREATE INDEX "shopify_product_variants_store_product_idx" ON "shopify_product_variants" USING btree ("store_id","product_id");--> statement-breakpoint
CREATE INDEX "shopify_product_variants_store_inventory_item_idx" ON "shopify_product_variants" USING btree ("store_id","inventory_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_products_store_shopify_id_unique" ON "shopify_products" USING btree ("store_id","shopify_product_id");--> statement-breakpoint
CREATE INDEX "shopify_products_store_status_idx" ON "shopify_products" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_metrics_store_customer_unique" ON "customer_metrics" USING btree ("store_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_metrics_store_date_unique" ON "daily_metrics" USING btree ("store_id","metric_date");--> statement-breakpoint
CREATE INDEX "daily_metrics_store_idx" ON "daily_metrics" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_metrics_store_product_date_unique" ON "product_metrics" USING btree ("store_id","product_id","metric_date");--> statement-breakpoint
CREATE INDEX "product_metrics_store_date_idx" ON "product_metrics" USING btree ("store_id","metric_date");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_metrics_store_date_unique" ON "revenue_metrics" USING btree ("store_id","metric_date");--> statement-breakpoint
CREATE INDEX "revenue_metrics_store_idx" ON "revenue_metrics" USING btree ("store_id");--> statement-breakpoint
-- ── M2: RLS tenant-isolation policies for the new data-plane + analytics tables ──
-- Same invariant as 0002: the restricted `profit_app` role physically cannot
-- read or write another tenant's rows; platform (owner) connections are exempt.
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'shopify_products',
    'shopify_product_variants',
    'shopify_customers',
    'shopify_orders',
    'shopify_order_line_items',
    'shopify_locations',
    'shopify_inventory_levels',
    'shopify_collections',
    'shopify_price_rules',
    'shopify_discount_codes',
    'shopify_metafields',
    'daily_metrics',
    'revenue_metrics',
    'product_metrics',
    'customer_metrics'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation_' || tenant_table, tenant_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO profit_app
         USING (store_id = nullif(current_setting(''app.store_id'', true), '''')::uuid)
         WITH CHECK (store_id = nullif(current_setting(''app.store_id'', true), '''')::uuid)',
      'tenant_isolation_' || tenant_table, tenant_table);
  END LOOP;
END $$;
--> statement-breakpoint
-- Belt-and-braces on top of 0002's ALTER DEFAULT PRIVILEGES: guarantee the new
-- tables are DML-accessible to the tenant role even if default privileges were
-- ever dropped by a manual DBA action.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO profit_app;
--> statement-breakpoint
-- ── M2 catalog additions: sync permissions for the remaining modules ──
-- Fresh environments get these via seedPlatformCatalogs; existing environments
-- are backfilled here so drift between environments is impossible.
INSERT INTO "permissions" ("code", "description") VALUES
  ('collections:sync', 'collections — sync'),
  ('discounts:sync', 'discounts — sync'),
  ('metafields:sync', 'metafields — sync')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
-- OWNER, ADMIN and MANAGER hold the full sync capability set (mirrors ROLE_MATRIX).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.code IN ('collections:sync', 'discounts:sync', 'metafields:sync')
WHERE r.code IN ('OWNER', 'ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;
