import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  ActionType,
  AiAgentId,
  AiCallStatus,
  AiProviderId,
  AiRunStatus,
  AiRunTrigger,
  AttributionMethod,
  EventActorType,
  ExecutionStatus,
  ModelTier,
  Priority,
  RecommendationEventType,
  RecommendationStatus,
  RecommendationType,
  RiskLevel,
} from "@profit/types";
import { baseColumns, enumToPgTuple } from "./_common";
import { stores } from "./merchant";
import { users } from "./iam";

/**
 * AI decision plane (PART 3/10). Invariants that keep the engine trustworthy:
 *
 *  1. EVERY recommendation carries an immutable evidence snapshot — captured
 *     at creation, never updated, so "what the AI saw" is reproducible forever
 *     (P3 evidence snapshots, P10 explainability).
 *  2. State transitions are append-only facts in recommendation_events; the
 *     status column is a projection of the latest event (P3 audit trail:
 *     "every AI decision stored, never deleted").
 *  3. Open-state dedupe is physical: a partial unique index on
 *     (store_id, fingerprint) WHERE status is open makes nightly+manual runs
 *     idempotent — the same insight can never stack twice.
 *  4. Attributed revenue is audited math, not AI prose: deterministic SQL in
 *     the attribution service links executed actions to orders by
 *     checkout_token / discount_code / customer window, then lands HERE in
 *     recommendation_outcomes (P3 "measure business impact").
 */

export const recommendationTypeEnum = pgEnum(
  "recommendation_type",
  enumToPgTuple(RecommendationType),
);
export const recommendationStatusEnum = pgEnum(
  "recommendation_status",
  enumToPgTuple(RecommendationStatus),
);
export const priorityEnum = pgEnum("priority", enumToPgTuple(Priority));
export const riskLevelEnum = pgEnum("risk_level", enumToPgTuple(RiskLevel));
export const actionTypeEnum = pgEnum("action_type", enumToPgTuple(ActionType));
export const aiAgentIdEnum = pgEnum("ai_agent_id", enumToPgTuple(AiAgentId));
export const aiProviderIdEnum = pgEnum("ai_provider_id", enumToPgTuple(AiProviderId));
export const modelTierEnum = pgEnum("model_tier", enumToPgTuple(ModelTier));
export const aiRunTriggerEnum = pgEnum("ai_run_trigger", enumToPgTuple(AiRunTrigger));
export const aiRunStatusEnum = pgEnum("ai_run_status", enumToPgTuple(AiRunStatus));
export const aiCallStatusEnum = pgEnum("ai_call_status", enumToPgTuple(AiCallStatus));
export const executionStatusEnum = pgEnum("execution_status", enumToPgTuple(ExecutionStatus));
export const attributionMethodEnum = pgEnum(
  "attribution_method",
  enumToPgTuple(AttributionMethod),
);
export const recommendationEventTypeEnum = pgEnum(
  "recommendation_event_type",
  enumToPgTuple(RecommendationEventType),
);
export const eventActorTypeEnum = pgEnum("event_actor_type", enumToPgTuple(EventActorType));

/** Completed-run ledger (one row per finished engine run — see header note 2's sibling:
 *  live "running" state is observable via background_jobs; this table is the audit). */
export const aiRuns = pgTable(
  "ai_runs",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    trigger: aiRunTriggerEnum("trigger").notNull(),
    status: aiRunStatusEnum("status").notNull(),
    /** Deterministic pre-AI store health score 0-100 with explanation parts. */
    storeHealthScore: integer("store_health_score"),
    storeHealthBreakdown: jsonb("store_health_breakdown").notNull().default(sql`'{}'::jsonb`),
    agentsPlanned: integer("agents_planned").notNull().default(0),
    agentsCompleted: integer("agents_completed").notNull().default(0),
    recommendationsCreated: integer("recommendations_created").notNull().default(0),
    duplicatesSkipped: integer("duplicates_skipped").notNull().default(0),
    /** Aggregated usage across calls: { inputTokens, outputTokens, costMicros, calls }. */
    usage: jsonb("usage").notNull().default(sql`'{}'::jsonb`),
    errorMessage: varchar("error_message", { length: 1000 }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("ai_runs_store_started_idx").on(table.storeId, table.startedAt),
    index("ai_runs_store_status_idx").on(table.storeId, table.status),
  ],
);

/** P10 per-call logging: request/response metadata, usage, cost, latency. */
export const aiCallLogs = pgTable(
  "ai_call_logs",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => aiRuns.id, { onDelete: "set null" }),
    agentId: aiAgentIdEnum("agent_id").notNull(),
    provider: aiProviderIdEnum("provider").notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    modelTier: modelTierEnum("model_tier").notNull(),
    promptId: varchar("prompt_id", { length: 128 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 32 }).notNull(),
    status: aiCallStatusEnum("status").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** USD micros (1e-6) — integer money math, float drift impossible. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Prompt/response digests (SHA-256) — full content stays out of the DB (P10 data privacy). */
    requestDigest: varchar("request_digest", { length: 64 }).notNull(),
    responseDigest: varchar("response_digest", { length: 64 }),
    errorMessage: varchar("error_message", { length: 1000 }),
  },
  (table) => [
    index("ai_call_logs_store_created_idx").on(table.storeId, table.createdAt),
    index("ai_call_logs_run_idx").on(table.runId),
  ],
);

export const recommendations = pgTable(
  "recommendations",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    /** Natural dedupe identity: sha256(storeId|agentId|ruleId|type|subjectKeys). */
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    type: recommendationTypeEnum("type").notNull(),
    agentId: aiAgentIdEnum("agent_id").notNull(),
    /** Catalog rule that fired (pure rules run BEFORE the model — P3). */
    ruleId: varchar("rule_id", { length: 64 }).notNull(),
    ruleVersion: integer("rule_version").notNull().default(1),
    title: varchar("title", { length: 200 }).notNull(),
    description: varchar("description", { length: 2000 }).notNull(),
    reasoning: jsonb("reasoning").notNull().default(sql`'[]'::jsonb`),
    priority: priorityEnum("priority").notNull(),
    /** 0-100, calibrated server-side (never trusting model output raw). */
    confidence: integer("confidence").notNull(),
    riskLevel: riskLevelEnum("risk_level").notNull(),
    estimatedRevenueCents: bigint("estimated_revenue_cents", { mode: "number" })
      .notNull()
      .default(0),
    estimatedCostCents: bigint("estimated_cost_cents", { mode: "number" })
      .notNull()
      .default(0),
    /** Subject pins for explainability + tool execution (product/customer/checkout ids). */
    subjects: jsonb("subjects").notNull().default(sql`'{}'::jsonb`),
    actionType: actionTypeEnum("action_type").notNull(),
    /** Validated, deterministic action parameters — the model proposes, the server disposes. */
    actionParams: jsonb("action_params").notNull().default(sql`'{}'::jsonb`),
    status: recommendationStatusEnum("status").notNull().default("PENDING_APPROVAL"),
    /** Optimistic concurrency: status transitions CAS on stateVersion. */
    stateVersion: integer("state_version").notNull().default(1),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decisionReason: varchar("decision_reason", { length: 1000 }),
    /** NULL = never expires. Expiry sweep transitions open rows past this to EXPIRED. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("recommendations_store_status_idx").on(table.storeId, table.status),
    index("recommendations_store_created_idx").on(table.storeId, table.createdAt),
    // Physical open-state dedupe — the same insight cannot stack while open.
    uniqueIndex("recommendations_open_fingerprint_unique")
      .on(table.storeId, table.fingerprint)
      .where(sql`"status" IN ('PENDING_APPROVAL','APPROVED','SCHEDULED','EXECUTING')`),
  ],
);

/** Immutable 1:1 snapshot of the inputs behind a recommendation (P3 evidence). */
export const recommendationEvidence = pgTable(
  "recommendation_evidence",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    /** { inputs: {...}, rulesFired: [...], model: {...}, computedAt } — written once. */
    snapshot: jsonb("snapshot").notNull(),
  },
  (table) => [
    uniqueIndex("recommendation_evidence_rec_unique").on(table.recommendationId),
    index("recommendation_evidence_store_idx").on(table.storeId),
  ],
);

/** Append-only audit trail (P3: never deleted, never updated). */
export const recommendationEvents = pgTable(
  "recommendation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    event: recommendationEventTypeEnum("event").notNull(),
    actorType: eventActorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    fromStatus: recommendationStatusEnum("from_status"),
    toStatus: recommendationStatusEnum("to_status"),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("recommendation_events_rec_idx").on(table.recommendationId, table.createdAt),
    index("recommendation_events_store_idx").on(table.storeId, table.createdAt),
  ],
);

/** Tool execution ledger — idempotency keys make queue retries physically safe. */
export const actionExecutions = pgTable(
  "action_executions",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    toolId: varchar("tool_id", { length: 96 }),
    actionType: actionTypeEnum("action_type").notNull(),
    status: executionStatusEnum("status").notNull().default("PENDING"),
    /** sha256(recommendationId|actionType|idempotencyScope) — unique per execution unit. */
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
    /** Merchant-facing rendering of what the tool used (to, subject, discount code...). */
    actionPreview: jsonb("action_preview").notNull().default(sql`'{}'::jsonb`),
    /** External references: { priceRuleId?, discountCode?, messageId?, checkoutToken? }. */
    toolRef: jsonb("tool_ref").notNull().default(sql`'{}'::jsonb`),
    attempts: integer("attempts").notNull().default(0),
    errorMessage: varchar("error_message", { length: 1000 }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("action_executions_idempotency_unique").on(table.idempotencyKey),
    index("action_executions_store_idx").on(table.storeId, table.createdAt),
    index("action_executions_rec_idx").on(table.recommendationId),
  ],
);

/** Measurement window outcome (P3 impact measurement + feedback loop input). */
export const recommendationOutcomes = pgTable(
  "recommendation_outcomes",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    executionId: uuid("execution_id").references(() => actionExecutions.id, {
      onDelete: "set null",
    }),
    method: attributionMethodEnum("method").notNull(),
    windowDays: integer("window_days").notNull(),
    attributedOrdersCount: integer("attributed_orders_count").notNull().default(0),
    attributedRevenueCents: bigint("attributed_revenue_cents", { mode: "number" })
      .notNull()
      .default(0),
    /** { orderIds: [...], matchedBy } — auditable linkage, capped. */
    linkage: jsonb("linkage").notNull().default(sql`'{}'::jsonb`),
    measuredAt: timestamp("measured_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("recommendation_outcomes_rec_unique").on(table.recommendationId),
    index("recommendation_outcomes_store_idx").on(table.storeId, table.measuredAt),
  ],
);
