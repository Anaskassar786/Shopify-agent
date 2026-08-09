CREATE TYPE "public"."billing_interval" AS ENUM('MONTHLY', 'YEARLY');--> statement-breakpoint
CREATE TYPE "public"."billing_event_type" AS ENUM('TRIAL_STARTED', 'TRIAL_NUDGE_SENT', 'TRIAL_EXPIRED', 'CHARGE_CREATED', 'CHARGE_ACCEPTED', 'CHARGE_DECLINED', 'CHARGE_CANCELLED', 'CHARGE_RECONCILED', 'PLAN_CHANGED', 'SUBSCRIPTION_SUSPENDED', 'SUBSCRIPTION_REACTIVATED');--> statement-breakpoint
CREATE TYPE "public"."engagement_event_kind" AS ENUM('STORE_CONNECTED', 'FIRST_SYNC_COMPLETED', 'FIRST_AI_RUN_COMPLETED', 'FIRST_AI_INSIGHT_VIEWED', 'FIRST_RECOMMENDATION_APPROVED', 'FIRST_AUTOMATION_ENABLED', 'UPGRADE_VIEWED', 'PAID_SUBSCRIPTION_STARTED', 'TRIAL_NUDGE_SENT', 'CHURN_NUDGE_SENT');--> statement-breakpoint
CREATE TYPE "public"."usage_meter" AS ENUM('AI_CALLS', 'EMAILS_SENT', 'SMS_SENT', 'AUTOMATION_RUNS');--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'CHARGE_PENDING';--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"type" "billing_event_type" NOT NULL,
	"plan_code" "plan_code",
	"charge_id" varchar(64),
	"amount_cents" integer,
	"interval" "billing_interval",
	"from_status" varchar(32),
	"to_status" varchar(32),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" "engagement_event_kind" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"meter" "usage_meter" NOT NULL,
	"bucket_date" date NOT NULL,
	"period_start" date,
	"count" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_interval" "billing_interval";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "grace_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_store_created_idx" ON "billing_events" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_events_type_idx" ON "billing_events" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_events_milestone_unique" ON "engagement_events" USING btree ("store_id","kind") WHERE kind IN ('STORE_CONNECTED','FIRST_SYNC_COMPLETED','FIRST_AI_RUN_COMPLETED','FIRST_AI_INSIGHT_VIEWED','FIRST_RECOMMENDATION_APPROVED','FIRST_AUTOMATION_ENABLED','PAID_SUBSCRIPTION_STARTED');--> statement-breakpoint
CREATE INDEX "engagement_events_store_created_idx" ON "engagement_events" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "engagement_events_kind_created_idx" ON "engagement_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_store_meter_day_unique" ON "usage_records" USING btree ("store_id","meter","bucket_date");--> statement-breakpoint
CREATE INDEX "usage_records_store_period_idx" ON "usage_records" USING btree ("store_id","period_start");-- ── RLS: tenant isolation on the billing/growth plane (fail-closed, same
-- pattern as 0002/0003/0004/0005 — unset app.store_id ⇒ zero rows/inserts) ──
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'usage_records',
    'billing_events',
    'engagement_events'
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
