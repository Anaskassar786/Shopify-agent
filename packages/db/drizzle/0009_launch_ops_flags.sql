CREATE TABLE "platform_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" varchar(80) NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "platform_flags_key_unique" UNIQUE("key")
);
--> statement-breakpoint
-- Platform ops flags (ADR 37): RLS enabled with NO tenant policy — default-deny
-- for the restricted profit_app role; only the owner role (platform admin
-- module + API composition root) ever reads/writes these rows. Platform-scope
-- singleton state must never ride a tenant table.
ALTER TABLE "platform_flags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO profit_app;
