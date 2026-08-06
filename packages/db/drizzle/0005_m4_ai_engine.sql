CREATE TYPE "public"."action_type" AS ENUM('SEND_RECOVERY_EMAIL', 'CREATE_DISCOUNT_CODE', 'ADVISORY');--> statement-breakpoint
CREATE TYPE "public"."ai_agent_id" AS ENUM('BUSINESS_ANALYST', 'CUSTOMER_INTELLIGENCE', 'REVENUE_RECOVERY', 'PRODUCT_INTELLIGENCE', 'INVENTORY');--> statement-breakpoint
CREATE TYPE "public"."ai_call_status" AS ENUM('SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."ai_provider_id" AS ENUM('GEMINI', 'OPENAI', 'CLAUDE', 'LOCAL');--> statement-breakpoint
CREATE TYPE "public"."ai_run_status" AS ENUM('COMPLETED', 'PROVIDER_UNAVAILABLE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."ai_run_trigger" AS ENUM('SCHEDULED', 'MANUAL', 'EVENT');--> statement-breakpoint
CREATE TYPE "public"."attribution_method" AS ENUM('CHECKOUT_TOKEN', 'DISCOUNT_CODE', 'CUSTOMER_WINDOW');--> statement-breakpoint
CREATE TYPE "public"."event_actor_type" AS ENUM('MERCHANT', 'SYSTEM', 'AI');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."model_tier" AS ENUM('TRIAGE', 'STANDARD', 'DEEP');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."recommendation_event_type" AS ENUM('CREATED', 'APPROVED', 'REJECTED', 'AUTO_APPROVED', 'EXECUTION_QUEUED', 'EXECUTED', 'EXECUTION_FAILED', 'EXPIRED', 'MEASURED');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SCHEDULED', 'EXECUTING', 'EXECUTED', 'FAILED', 'EXPIRED', 'MEASURED');--> statement-breakpoint
CREATE TYPE "public"."recommendation_type" AS ENUM('RECOVER_ABANDONED_CART', 'RESTOCK', 'REMOVE_DEAD_STOCK', 'TARGET_VIP', 'WINBACK_INACTIVE', 'LAUNCH_PROMOTION', 'REDUCE_REFUND_RISK', 'REVENUE_DECLINE_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
ALTER TYPE "public"."sync_module" ADD VALUE 'CHECKOUTS';--> statement-breakpoint
CREATE TABLE "shopify_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_checkout_id" varchar(64) NOT NULL,
	"token" varchar(128) NOT NULL,
	"email" varchar(320),
	"customer_id" uuid,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"total_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"web_url" varchar(1024),
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"shopify_created_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "action_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"tool_id" varchar(96),
	"action_type" "action_type" NOT NULL,
	"status" "execution_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"action_preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_message" varchar(1000),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"run_id" uuid,
	"agent_id" "ai_agent_id" NOT NULL,
	"provider" "ai_provider_id" NOT NULL,
	"model" varchar(128) NOT NULL,
	"model_tier" "model_tier" NOT NULL,
	"prompt_id" varchar(128) NOT NULL,
	"prompt_version" varchar(32) NOT NULL,
	"status" "ai_call_status" NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"response_digest" varchar(64),
	"error_message" varchar(1000)
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"trigger" "ai_run_trigger" NOT NULL,
	"status" "ai_run_status" NOT NULL,
	"store_health_score" integer,
	"store_health_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agents_planned" integer DEFAULT 0 NOT NULL,
	"agents_completed" integer DEFAULT 0 NOT NULL,
	"recommendations_created" integer DEFAULT 0 NOT NULL,
	"duplicates_skipped" integer DEFAULT 0 NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" varchar(1000),
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"event" "recommendation_event_type" NOT NULL,
	"actor_type" "event_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"from_status" "recommendation_status",
	"to_status" "recommendation_status",
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"execution_id" uuid,
	"method" "attribution_method" NOT NULL,
	"window_days" integer NOT NULL,
	"attributed_orders_count" integer DEFAULT 0 NOT NULL,
	"attributed_revenue_cents" bigint DEFAULT 0 NOT NULL,
	"linkage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"measured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"type" "recommendation_type" NOT NULL,
	"agent_id" "ai_agent_id" NOT NULL,
	"rule_id" varchar(64) NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" varchar(2000) NOT NULL,
	"reasoning" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" "priority" NOT NULL,
	"confidence" integer NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"estimated_revenue_cents" bigint DEFAULT 0 NOT NULL,
	"estimated_cost_cents" bigint DEFAULT 0 NOT NULL,
	"subjects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_type" "action_type" NOT NULL,
	"action_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "recommendation_status" DEFAULT 'PENDING_APPROVAL' NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" varchar(1000),
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "checkout_token" varchar(128);--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "discount_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shopify_checkouts" ADD CONSTRAINT "shopify_checkouts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_checkouts" ADD CONSTRAINT "shopify_checkouts_customer_id_shopify_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."shopify_customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_outcomes" ADD CONSTRAINT "recommendation_outcomes_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_outcomes" ADD CONSTRAINT "recommendation_outcomes_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_outcomes" ADD CONSTRAINT "recommendation_outcomes_execution_id_action_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."action_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_checkouts_store_token_unique" ON "shopify_checkouts" USING btree ("store_id","token");--> statement-breakpoint
CREATE INDEX "shopify_checkouts_store_created_idx" ON "shopify_checkouts" USING btree ("store_id","shopify_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "action_executions_idempotency_unique" ON "action_executions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "action_executions_store_idx" ON "action_executions" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "action_executions_rec_idx" ON "action_executions" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "ai_call_logs_store_created_idx" ON "ai_call_logs" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_call_logs_run_idx" ON "ai_call_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_runs_store_started_idx" ON "ai_runs" USING btree ("store_id","started_at");--> statement-breakpoint
CREATE INDEX "ai_runs_store_status_idx" ON "ai_runs" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "recommendation_events_rec_idx" ON "recommendation_events" USING btree ("recommendation_id","created_at");--> statement-breakpoint
CREATE INDEX "recommendation_events_store_idx" ON "recommendation_events" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_evidence_rec_unique" ON "recommendation_evidence" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "recommendation_evidence_store_idx" ON "recommendation_evidence" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_outcomes_rec_unique" ON "recommendation_outcomes" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "recommendation_outcomes_store_idx" ON "recommendation_outcomes" USING btree ("store_id","measured_at");--> statement-breakpoint
CREATE INDEX "recommendations_store_status_idx" ON "recommendations" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "recommendations_store_created_idx" ON "recommendations" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_open_fingerprint_unique" ON "recommendations" USING btree ("store_id","fingerprint") WHERE "status" IN ('PENDING_APPROVAL','APPROVED','SCHEDULED','EXECUTING');--> statement-breakpoint
-- ── RLS: tenant isolation on the AI decision plane + checkouts (fail-closed,
-- same pattern as 0002/0003/0004 — unset app.store_id ⇒ zero rows/inserts) ──
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'ai_runs',
    'ai_call_logs',
    'recommendations',
    'recommendation_evidence',
    'recommendation_events',
    'action_executions',
    'recommendation_outcomes',
    'shopify_checkouts'
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
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO profit_app;
