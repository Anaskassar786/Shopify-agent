import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { BillingEventType, EngagementEventKind, UsageMeter } from "@profit/types";
import { baseColumns, enumToPgTuple } from "./_common";
import { billingIntervalEnum, planCodeEnum, stores } from "./merchant";
import { users } from "./iam";

export const usageMeterEnum = pgEnum("usage_meter", enumToPgTuple(UsageMeter));
export const billingEventTypeEnum = pgEnum(
  "billing_event_type",
  enumToPgTuple(BillingEventType),
);
export const engagementEventKindEnum = pgEnum(
  "engagement_event_kind",
  enumToPgTuple(EngagementEventKind),
);

/**
 * Convergent daily usage rollups per meter (M5, P2 usage-based readiness).
 * Rows are REWRITTEN by the usage rollup job (unique store+meter+day) from the
 * metering sources of truth (`ai_call_logs`, `action_executions`) — this table
 * is a queryable projection, never an event duplicate, so re-running the job
 * is always safe.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    meter: usageMeterEnum("meter").notNull(),
    /** UTC calendar day the consumption happened on. */
    bucketDate: date("bucket_date", { mode: "string" }).notNull(),
    /**
     * Billing period the bucket belongs to (subscription.current_period_start at
     * rollup time; null while TRIALING — trial consumption is still metered).
     */
    periodStart: date("period_start", { mode: "string" }),
    count: bigint("count", { mode: "number" }).notNull().default(0),
    /** Micro-USD cost (AI only; 1_000_000 micros = $1) — feeds the margin dashboard. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    uniqueIndex("usage_records_store_meter_day_unique").on(
      table.storeId,
      table.meter,
      table.bucketDate,
    ),
    index("usage_records_store_period_idx").on(table.storeId, table.periodStart),
  ],
);

/**
 * Billing lifecycle ledger (M5): the audit-grade source behind the merchant's
 * billing history UI. Append-only; never updated or deleted.
 * Amendment vs P2 taxonomy: supersedes `invoices`/`payments` rows — Shopify
 * issues the actual invoices (visible in Shopify Admin); the platform records
 * the lifecycle that produced them, verified against the Billing API.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    type: billingEventTypeEnum("type").notNull(),
    planCode: planCodeEnum("plan_code"),
    /** Shopify recurring charge id when the event is charge-linked. */
    chargeId: varchar("charge_id", { length: 64 }),
    amountCents: integer("amount_cents"),
    interval: billingIntervalEnum("interval"),
    fromStatus: varchar("from_status", { length: 32 }),
    toStatus: varchar("to_status", { length: 32 }),
    /** Small structured context (confirmation status, nudge day, reconcile drift…). */
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    index("billing_events_store_created_idx").on(table.storeId, table.createdAt),
    index("billing_events_type_idx").on(table.type),
  ],
);

/**
 * Engagement & activation funnel events (M5, P11). First-time milestone kinds
 * (ENGAGEMENT_MILESTONE_KINDS) are deduped per store by a partial unique index:
 * the funnel can never double-count, and emit calls are idempotent by
 * construction. Repeatable kinds (nudges, upgrade views) carry no dedupe.
 */
export const engagementEvents = pgTable(
  "engagement_events",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: engagementEventKindEnum("kind").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    /* Predicate mirrors ENGAGEMENT_MILESTONE_KINDS (packages/types) — kept as a
       * literal so the migration snapshot is deterministic; enums.test pins sync. */
    uniqueIndex("engagement_events_milestone_unique")
      .on(table.storeId, table.kind)
      .where(
        sql`kind IN ('STORE_CONNECTED','FIRST_SYNC_COMPLETED','FIRST_AI_RUN_COMPLETED','FIRST_AI_INSIGHT_VIEWED','FIRST_RECOMMENDATION_APPROVED','FIRST_AUTOMATION_ENABLED','PAID_SUBSCRIPTION_STARTED')`,
      ),
    index("engagement_events_store_created_idx").on(table.storeId, table.createdAt),
    index("engagement_events_kind_created_idx").on(table.kind, table.createdAt),
  ],
);
