CREATE TYPE "public"."copilot_message_role" AS ENUM('MERCHANT', 'ASSISTANT');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('BUILDING', 'READY', 'FAILED');--> statement-breakpoint
ALTER TYPE "public"."ai_agent_id" ADD VALUE 'PRICING';--> statement-breakpoint
ALTER TYPE "public"."ai_agent_id" ADD VALUE 'EXECUTIVE';--> statement-breakpoint
ALTER TYPE "public"."recommendation_type" ADD VALUE 'ADJUST_PRICE';--> statement-breakpoint
CREATE TABLE "ai_copilot_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"opened_by_user_id" uuid,
	"title" varchar(160) NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_copilot_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "copilot_message_role" NOT NULL,
	"intent" varchar(40),
	"content" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" "report_kind" NOT NULL,
	"status" "report_status" DEFAULT 'BUILDING' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"headline" varchar(280),
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"executive_summary" text,
	"method_version" integer DEFAULT 1 NOT NULL,
	"pdf_bytes" "bytea",
	"pdf_size_bytes" integer,
	"last_emailed_on" varchar(10),
	"completed_at" timestamp with time zone,
	"error_message" varchar(1000)
);
--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "report_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_copilot_conversations" ADD CONSTRAINT "ai_copilot_conversations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_copilot_conversations" ADD CONSTRAINT "ai_copilot_conversations_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_copilot_messages" ADD CONSTRAINT "ai_copilot_messages_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_copilot_messages" ADD CONSTRAINT "ai_copilot_messages_conversation_id_ai_copilot_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_copilot_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_copilot_conversations_store_recent_idx" ON "ai_copilot_conversations" USING btree ("store_id","last_message_at");--> statement-breakpoint
CREATE INDEX "ai_copilot_messages_conversation_idx" ON "ai_copilot_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_copilot_messages_store_created_idx" ON "ai_copilot_messages" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_store_kind_period_unique" ON "reports" USING btree ("store_id","kind","period_start","period_end");--> statement-breakpoint
CREATE INDEX "reports_store_kind_created_idx" ON "reports" USING btree ("store_id","kind","created_at");-- ── RLS: tenant isolation on the phase-3 plane (fail-closed, same pattern as
-- 0002…0007 — unset app.store_id ⇒ zero rows/inserts) ──
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'ai_copilot_conversations',
    'ai_copilot_messages',
    'reports'
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
