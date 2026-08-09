CREATE TYPE "public"."access_override_kind" AS ENUM('COMP_ACCESS');--> statement-breakpoint
CREATE TYPE "public"."campaign_audience" AS ENUM('ALL_CUSTOMERS', 'MARKETING_OPT_IN', 'REPEAT_CUSTOMERS');--> statement-breakpoint
CREATE TYPE "public"."campaign_recipient_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."export_format" AS ENUM('CSV', 'XLSX', 'PDF');--> statement-breakpoint
CREATE TYPE "public"."export_kind" AS ENUM('AUDIT_LOGS', 'CUSTOMERS', 'ORDERS', 'PRODUCTS', 'RECOMMENDATIONS');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('QUEUED', 'RUNNING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('EMAIL', 'SMS');--> statement-breakpoint
CREATE TYPE "public"."message_event_kind" AS ENUM('SENT', 'FAILED', 'OPENED', 'CLICKED', 'UNSUBSCRIBED');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_category" AS ENUM('BUG', 'BILLING', 'DATA', 'FEATURE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('OPEN', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."ticket_author_kind" AS ENUM('MERCHANT', 'OPERATOR');--> statement-breakpoint
CREATE TYPE "public"."workflow_node_kind" AS ENUM('TRIGGER', 'CONDITION', 'DELAY', 'SEND_EMAIL', 'SEND_SMS', 'TAG_CUSTOMER', 'CREATE_DISCOUNT');--> statement-breakpoint
CREATE TYPE "public"."workflow_run_status" AS ENUM('RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."workflow_step_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."workflow_trigger_kind" AS ENUM('MANUAL', 'SCHEDULE', 'EVENT');--> statement-breakpoint
ALTER TYPE "public"."engagement_event_kind" ADD VALUE 'FIRST_WORKFLOW_ACTIVATED';--> statement-breakpoint
ALTER TYPE "public"."engagement_event_kind" ADD VALUE 'FIRST_CAMPAIGN_SENT';--> statement-breakpoint
ALTER TYPE "public"."billing_event_type" ADD VALUE 'TRIAL_EXTENDED';--> statement-breakpoint
CREATE TABLE "access_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" "access_override_kind" DEFAULT 'COMP_ACCESS' NOT NULL,
	"access_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"granted_by" varchar(200) NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" varchar(200),
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"customer_id" uuid,
	"destination" varchar(320) NOT NULL,
	"variant" varchar(1) DEFAULT 'A' NOT NULL,
	"status" "campaign_recipient_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_ref" varchar(120),
	"sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" varchar(140) NOT NULL,
	"channel" "message_channel" NOT NULL,
	"audience" "campaign_audience" NOT NULL,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"variant_a" jsonb NOT NULL,
	"variant_b" jsonb,
	"split_b_percent" integer DEFAULT 50 NOT NULL,
	"winner_variant" varchar(1),
	"scheduled_at" timestamp with time zone,
	"sending_started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"kind" "export_kind" NOT NULL,
	"format" "export_format" NOT NULL,
	"status" "export_status" DEFAULT 'QUEUED' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_name" varchar(220),
	"file_data" "bytea",
	"row_count" integer,
	"size_bytes" integer,
	"error" text,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"kind" "message_event_kind" NOT NULL,
	"url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"destination" varchar(320) NOT NULL,
	"reason" varchar(40) NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" varchar(140) NOT NULL,
	"channel" "message_channel" NOT NULL,
	"subject" varchar(200),
	"body_text" text NOT NULL,
	"body_html" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid,
	"operator_id" varchar(200) NOT NULL,
	"action" varchar(120) NOT NULL,
	"target_type" varchar(60) NOT NULL,
	"target_id" varchar(120) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"ip" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_kind" "ticket_author_kind" NOT NULL,
	"author_user_id" uuid,
	"author_operator" varchar(200),
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"opened_by_user_id" uuid,
	"subject" varchar(200) NOT NULL,
	"category" "support_ticket_category" NOT NULL,
	"priority" "support_ticket_priority" DEFAULT 'NORMAL' NOT NULL,
	"status" "support_ticket_status" DEFAULT 'OPEN' NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"assigned_operator" varchar(200),
	"operator_attention" boolean DEFAULT true NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" varchar(80) NOT NULL,
	"node_kind" "workflow_node_kind" NOT NULL,
	"status" "workflow_step_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"status" "workflow_run_status" DEFAULT 'RUNNING' NOT NULL,
	"trigger_kind" "workflow_trigger_kind" NOT NULL,
	"trigger_event_id" varchar(200) NOT NULL,
	"subject" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resume_at" timestamp with time zone,
	"resume_from_node_id" varchar(80),
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" varchar(140) NOT NULL,
	"description" text,
	"status" "workflow_status" DEFAULT 'DRAFT' NOT NULL,
	"active_version_id" uuid,
	"next_fire_at" timestamp with time zone,
	"created_by_user_id" uuid
);
--> statement-breakpoint
DROP INDEX "engagement_events_milestone_unique";--> statement-breakpoint
ALTER TABLE "access_overrides" ADD CONSTRAINT "access_overrides_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_customer_id_shopify_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."shopify_customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_recipient_id_campaign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."campaign_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_suppressions" ADD CONSTRAINT "message_suppressions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD CONSTRAINT "workflow_run_steps_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD CONSTRAINT "workflow_run_steps_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_version_id_workflow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_overrides_store_active_idx" ON "access_overrides" USING btree ("store_id","access_until") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_campaign_destination_unique" ON "campaign_recipients" USING btree ("campaign_id","destination");--> statement-breakpoint
CREATE INDEX "campaign_recipients_campaign_status_idx" ON "campaign_recipients" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaign_recipients_store_idx" ON "campaign_recipients" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "campaigns_store_status_idx" ON "campaigns" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_scheduled_idx" ON "campaigns" USING btree ("scheduled_at") WHERE status = 'SCHEDULED' AND scheduled_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "exports_store_created_idx" ON "exports" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "exports_expiry_idx" ON "exports" USING btree ("expires_at") WHERE status = 'READY' AND expires_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_events_recipient_idx" ON "message_events" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "message_events_campaign_kind_idx" ON "message_events" USING btree ("campaign_id","kind");--> statement-breakpoint
CREATE INDEX "message_events_store_idx" ON "message_events" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_suppressions_store_channel_destination_unique" ON "message_suppressions" USING btree ("store_id","channel","destination");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_store_name_channel_unique" ON "message_templates" USING btree ("store_id","name","channel");--> statement-breakpoint
CREATE INDEX "message_templates_store_channel_idx" ON "message_templates" USING btree ("store_id","channel");--> statement-breakpoint
CREATE INDEX "platform_admin_actions_store_idx" ON "platform_admin_actions" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_admin_actions_action_idx" ON "platform_admin_actions" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "support_ticket_messages_ticket_idx" ON "support_ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "support_ticket_messages_store_idx" ON "support_ticket_messages" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "support_tickets_store_status_idx" ON "support_tickets" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "support_tickets_operator_idx" ON "support_tickets" USING btree ("operator_attention","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_steps_run_node_unique" ON "workflow_run_steps" USING btree ("run_id","node_id");--> statement-breakpoint
CREATE INDEX "workflow_run_steps_store_idx" ON "workflow_run_steps" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_workflow_trigger_unique" ON "workflow_runs" USING btree ("workflow_id","trigger_event_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_store_created_idx" ON "workflow_runs" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_resume_idx" ON "workflow_runs" USING btree ("resume_at") WHERE status = 'WAITING' AND resume_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_workflow_version_unique" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflow_versions_store_idx" ON "workflow_versions" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "workflows_store_status_idx" ON "workflows" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "workflows_next_fire_idx" ON "workflows" USING btree ("next_fire_at") WHERE status = 'ACTIVE' AND next_fire_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_events_milestone_unique" ON "engagement_events" USING btree ("store_id","kind") WHERE kind IN ('STORE_CONNECTED','FIRST_SYNC_COMPLETED','FIRST_AI_RUN_COMPLETED','FIRST_AI_INSIGHT_VIEWED','FIRST_RECOMMENDATION_APPROVED','FIRST_AUTOMATION_ENABLED','PAID_SUBSCRIPTION_STARTED','FIRST_WORKFLOW_ACTIVATED','FIRST_CAMPAIGN_SENT');--> statement-breakpoint
-- ── RLS: tenant isolation on the automation/campaigns plane (fail-closed, same
-- pattern as 0002/0003/0004/0005/0006 — unset app.store_id ⇒ zero rows/inserts) ──
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'workflows',
    'workflow_versions',
    'workflow_runs',
    'workflow_run_steps',
    'message_templates',
    'campaigns',
    'campaign_recipients',
    'message_events',
    'message_suppressions',
    'exports',
    'support_tickets',
    'support_ticket_messages',
    'access_overrides'
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
-- Platform write ledger: RLS enabled with NO tenant policy — default-deny for
-- the restricted profit_app role; only the owner role (platform admin module)
-- ever reads/writes these rows.
ALTER TABLE "platform_admin_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO profit_app;
