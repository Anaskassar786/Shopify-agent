import { sql } from "drizzle-orm";
import { jsonb, pgTable, varchar } from "drizzle-orm/pg-core";
import { baseColumns } from "./_common";

/**
 * Platform-scope operational flags (launch readiness, ADR 37): a generic
 * key/value container so future platform switches NEVER need a migration.
 * First key: `maintenance` → {enabled: boolean, message: string | null,
 * setAt: iso, setBy: operatorId}.
 *
 * Platform table (same defense pattern as `platform_admin_actions`): RLS
 * enabled with NO tenant policy — the restricted profit_app role is
 * default-denied; only the owner role (admin module + API composition root)
 * reads/writes these rows.
 */
export const platformFlags = pgTable("platform_flags", {
  ...baseColumns,
  key: varchar("key", { length: 80 }).notNull().unique(),
  value: jsonb("value").notNull().default(sql`'{}'::jsonb`),
});
