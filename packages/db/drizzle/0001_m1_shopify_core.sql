CREATE TABLE "shopify_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" varchar(128) NOT NULL,
	"shop_domain" varchar(255) NOT NULL,
	"grant_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "shopify_user_id" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_oauth_states_state_unique" ON "shopify_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "shopify_oauth_states_shop_idx" ON "shopify_oauth_states" USING btree ("shop_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "users_shopify_user_unique" ON "users" USING btree ("shopify_user_id") WHERE "users"."shopify_user_id" is not null;