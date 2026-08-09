import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  CopilotMessageRole,
  ReportKind,
  ReportStatus,
} from "@profit/types";
import { baseColumns, enumToPgTuple } from "./_common";
import { users } from "./iam";
import { stores } from "./merchant";

/**
 * Phase-3 schema (M8): AI copilot conversations + enterprise period reports.
 * Both planes are tenant tables (`store_id` + RLS, same policy loop as M2/M6);
 * additive migration 0008 — no existing table changes.
 */

/**
 * bytea column (report PDFs). postgres-js hands back Buffer; PGlite
 * materializes bytea as Uint8Array — fromDriver normalizes both to Buffer so
 * application code never branches on the driver.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  },
});

export const copilotMessageRoleEnum = pgEnum(
  "copilot_message_role",
  enumToPgTuple(CopilotMessageRole),
);
export const reportKindEnum = pgEnum("report_kind", enumToPgTuple(ReportKind));
export const reportStatusEnum = pgEnum("report_status", enumToPgTuple(ReportStatus));

export const aiCopilotConversations = pgTable(
  "ai_copilot_conversations",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    openedByUserId: uuid("opened_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** First user question, truncated — conversation lists read it directly. */
    title: varchar("title", { length: 160 }).notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_copilot_conversations_store_recent_idx").on(table.storeId, table.lastMessageAt),
  ],
);

export const aiCopilotMessages = pgTable(
  "ai_copilot_messages",
  {
    ...baseColumns,
    /** Denormalized tenant key (RLS + scoped reads without a join, jobs-plate precedent). */
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiCopilotConversations.id, { onDelete: "cascade" }),
    role: copilotMessageRoleEnum("role").notNull(),
    /** Classified intent (assistant rows; ADR 32 deterministic routing). */
    intent: varchar("intent", { length: 40 }),
    content: text("content").notNull(),
    /**
     * Assistant envelope: evidence ids + method + confidence + linked
     * recommendation ids — the merchant-visible trail (never prose-only).
     */
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    index("ai_copilot_messages_conversation_idx").on(table.conversationId, table.createdAt),
    index("ai_copilot_messages_store_created_idx").on(table.storeId, table.createdAt),
  ],
);

export const reports = pgTable(
  "reports",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    kind: reportKindEnum("kind").notNull(),
    status: reportStatusEnum("status").notNull().default(ReportStatus.Building),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
    headline: varchar("headline", { length: 280 }),
    /** Deterministic KPI sections (deltas, movers, forecast, ledger counts). */
    sections: jsonb("sections").notNull().default(sql`'{}'::jsonb`),
    /** Executive agent summary (model-phrased when configured — ADR 32/36). */
    executiveSummary: text("executive_summary"),
    /** Method/idempotency version — a method bump re-computable by regenerate. */
    methodVersion: integer("method_version").notNull().default(1),
    pdfBytes: bytea("pdf_bytes"),
    pdfSizeBytes: integer("pdf_size_bytes"),
    /** UTC calendar date (YYYY-MM-DD) the report was last emailed. */
    lastEmailedOn: varchar("last_emailed_on", { length: 10 }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    errorMessage: varchar("error_message", { length: 1000 }),
  },
  (table) => [
    uniqueIndex("reports_store_kind_period_unique").on(
      table.storeId,
      table.kind,
      table.periodStart,
      table.periodEnd,
    ),
    index("reports_store_kind_created_idx").on(table.storeId, table.kind, table.createdAt),
  ],
);
