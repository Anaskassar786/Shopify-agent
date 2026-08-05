import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { AuditResult } from "@profit/types";
import { baseColumns, enumToPgTuple } from "./_common";
import { users } from "./iam";
import { stores } from "./merchant";

export const auditResultEnum = pgEnum("audit_result", enumToPgTuple(AuditResult));

/**
 * Append-only audit trail (P2/P5/P12). Rows are never updated or deleted by the
 * application; GDPR erasure runs through the dedicated erasure service which
 * pseudonymises rather than deletes (P7: audit downloads stay meaningful).
 * storeId is null only for platform-admin actions outside any tenant.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    ...baseColumns,
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** e.g. "authentication.login", "automation.approved", "billing.subscription.cancelled". */
    action: varchar("action", { length: 128 }).notNull(),
    entityType: varchar("entity_type", { length: 128 }),
    entityId: varchar("entity_id", { length: 64 }),
    result: auditResultEnum("result").notNull(),
    ip: varchar("ip", { length: 45 }),
    userAgent: text("user_agent"),
    /** Action-specific context; must be pre-redacted by the emitting service. */
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    index("audit_logs_store_time_idx").on(table.storeId, table.createdAt),
    index("audit_logs_user_idx").on(table.userId, table.createdAt),
    index("audit_logs_action_idx").on(table.action),
  ],
);
