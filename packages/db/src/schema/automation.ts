import { sql } from "drizzle-orm";
import {
  boolean,
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
  AccessOverrideKind,
  CampaignAudience,
  CampaignRecipientStatus,
  CampaignStatus,
  ExportFormat,
  ExportKind,
  ExportStatus,
  MessageChannel,
  MessageEventKind,
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
  TicketAuthorKind,
  WorkflowNodeKind,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowStepStatus,
  WorkflowTriggerKind,
} from "@profit/types";
import { baseColumns, enumToPgTuple } from "./_common";
import { stores } from "./merchant";
import { users } from "./iam";
import { shopifyCustomers } from "./shopify-data";

/**
 * M6 automation + campaigns data plane. Tenant tables follow the PART 2
 * mandate (id, store_id, created_at, updated_at) and land in the migration's
 * RLS DO block; `platform_admin_actions` is a platform table (RLS enabled,
 * NO tenant policy — only the owner role reaches it, from the admin module).
 */

/** bytea column (export files). Buffers flow through untouched on both drivers. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const workflowStatusEnum = pgEnum("workflow_status", enumToPgTuple(WorkflowStatus));
export const workflowTriggerKindEnum = pgEnum(
  "workflow_trigger_kind",
  enumToPgTuple(WorkflowTriggerKind),
);
export const workflowNodeKindEnum = pgEnum(
  "workflow_node_kind",
  enumToPgTuple(WorkflowNodeKind),
);
export const workflowRunStatusEnum = pgEnum(
  "workflow_run_status",
  enumToPgTuple(WorkflowRunStatus),
);
export const workflowStepStatusEnum = pgEnum(
  "workflow_step_status",
  enumToPgTuple(WorkflowStepStatus),
);
export const messageChannelEnum = pgEnum("message_channel", enumToPgTuple(MessageChannel));
export const campaignStatusEnum = pgEnum("campaign_status", enumToPgTuple(CampaignStatus));
export const campaignAudienceEnum = pgEnum(
  "campaign_audience",
  enumToPgTuple(CampaignAudience),
);
export const campaignRecipientStatusEnum = pgEnum(
  "campaign_recipient_status",
  enumToPgTuple(CampaignRecipientStatus),
);
export const messageEventKindEnum = pgEnum(
  "message_event_kind",
  enumToPgTuple(MessageEventKind),
);
export const exportKindEnum = pgEnum("export_kind", enumToPgTuple(ExportKind));
export const exportFormatEnum = pgEnum("export_format", enumToPgTuple(ExportFormat));
export const exportStatusEnum = pgEnum("export_status", enumToPgTuple(ExportStatus));
export const supportTicketStatusEnum = pgEnum(
  "support_ticket_status",
  enumToPgTuple(SupportTicketStatus),
);
export const supportTicketCategoryEnum = pgEnum(
  "support_ticket_category",
  enumToPgTuple(SupportTicketCategory),
);
export const supportTicketPriorityEnum = pgEnum(
  "support_ticket_priority",
  enumToPgTuple(SupportTicketPriority),
);
export const ticketAuthorKindEnum = pgEnum(
  "ticket_author_kind",
  enumToPgTuple(TicketAuthorKind),
);
export const accessOverrideKindEnum = pgEnum(
  "access_override_kind",
  enumToPgTuple(AccessOverrideKind),
);

/**
 * Workflow headers (M6). The runnable graph lives in immutable
 * `workflow_versions`; `activeVersionId` pins which version runs (plain
 * column by design — a FK would create a cyclic dependency between the two
 * tables at DDL time; integrity is enforced by WorkflowService transitions).
 * `nextFireAt` drives the scheduler scan for SCHEDULE-trigger workflows only.
 */
export const workflows = pgTable(
  "workflows",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 140 }).notNull(),
    description: text("description"),
    status: workflowStatusEnum("status").notNull().default(WorkflowStatus.Draft),
    /** Pinned runnable version; null while the workflow has never been activated. */
    activeVersionId: uuid("active_version_id"),
    /** Next scheduled fire (UTC) — SCHEDULE triggers only; indexed below. */
    nextFireAt: timestamp("next_fire_at", { withTimezone: true, mode: "date" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("workflows_store_status_idx").on(table.storeId, table.status),
    index("workflows_next_fire_idx")
      .on(table.nextFireAt)
      .where(sql`status = 'ACTIVE' AND next_fire_at IS NOT NULL`),
  ],
);

/**
 * Immutable workflow definitions (M6). A version is append-only — merchants
 * edit by creating a new version, so in-flight runs always complete against
 * the graph they started with (P5 resume correctness).
 * `definition` shape: { trigger: {kind, config}, nodes: [...], edges: [...] }
 * validated by @profit/automation's DAG validator before insert.
 */
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("workflow_versions_workflow_version_unique").on(
      table.workflowId,
      table.version,
    ),
    index("workflow_versions_store_idx").on(table.storeId),
  ],
);

/**
 * Workflow runs (M6 ledger). `triggerEventId` is the idempotency key: webhook
 * deliveries, manual clicks and scheduler fires each carry a stable id, and
 * the unique index collapses any duplicate fan-out into one run.
 * `subject` is the PII-minimal run context (customer identity + event refs)
 * the templater and condition evaluator read from.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    status: workflowRunStatusEnum("status").notNull().default(WorkflowRunStatus.Running),
    triggerKind: workflowTriggerKindEnum("trigger_kind").notNull(),
    triggerEventId: varchar("trigger_event_id", { length: 200 }).notNull(),
    subject: jsonb("subject").notNull().default(sql`'{}'::jsonb`),
    /** DELAY suspension point — the scheduler tick resumes runs whose time came. */
    resumeAt: timestamp("resume_at", { withTimezone: true, mode: "date" }),
    /** Node id the run resumes at (the DELAY node's successors). */
    resumeFromNodeId: varchar("resume_from_node_id", { length: 80 }),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("workflow_runs_workflow_trigger_unique").on(
      table.workflowId,
      table.triggerEventId,
    ),
    index("workflow_runs_store_created_idx").on(table.storeId, table.createdAt),
    index("workflow_runs_resume_idx")
      .on(table.resumeAt)
      .where(sql`status = 'WAITING' AND resume_at IS NOT NULL`),
  ],
);

/**
 * Per-node checkpoints (M6). unique(runId, nodeId): an acyclic graph visits a
 * node at most once per run, so a retry re-executing the walk finds completed
 * steps and skips them — crash-resume by construction (same contract as the
 * M4 action_executions checkpoints).
 */
export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    nodeId: varchar("node_id", { length: 80 }).notNull(),
    nodeKind: workflowNodeKindEnum("node_kind").notNull(),
    status: workflowStepStatusEnum("status").notNull().default(WorkflowStepStatus.Pending),
    attempts: integer("attempts").notNull().default(0),
    /** Step outputs/tool refs (message ids, price-rule ids, applied tags). */
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("workflow_run_steps_run_node_unique").on(table.runId, table.nodeId),
    index("workflow_run_steps_store_idx").on(table.storeId),
  ],
);

/** Reusable message templates (M6). Bodies carry {{variable}} placeholders rendered server-side. */
export const messageTemplates = pgTable(
  "message_templates",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 140 }).notNull(),
    channel: messageChannelEnum("channel").notNull(),
    /** Email only; null for SMS. */
    subject: varchar("subject", { length: 200 }),
    bodyText: text("body_text").notNull(),
    /** Email only; optional HTML twin. Variables render inside it too. */
    bodyHtml: text("body_html"),
    /** Content revision — bumped on every body/subject edit. */
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("message_templates_store_name_channel_unique").on(
      table.storeId,
      table.name,
      table.channel,
    ),
    index("message_templates_store_channel_idx").on(table.storeId, table.channel),
  ],
);

/**
 * Campaigns (M6). Variant payloads are immutable snapshots
 * ({ templateId?, subject?, bodyText, bodyHtml? }) taken at schedule/dispatch
 * time, so later template edits never rewrite what recipients received.
 * A/B: recipients are deterministically assigned A or B by hashing their
 * customer id against the campaign id (stable across retries).
 * Counter columns are maintained convergently at batch completion (never
 * incremented blindly — each send batch re-derives its contribution).
 */
export const campaigns = pgTable(
  "campaigns",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 140 }).notNull(),
    channel: messageChannelEnum("channel").notNull(),
    audience: campaignAudienceEnum("audience").notNull(),
    status: campaignStatusEnum("status").notNull().default(CampaignStatus.Draft),
    variantA: jsonb("variant_a").notNull(),
    variantB: jsonb("variant_b"),
    /** Percent of the audience receiving variant B (0-100). */
    splitBPercent: integer("split_b_percent").notNull().default(50),
    /** Declared A/B winner ("A"/"B") after results are in — operator decision. */
    winnerVariant: varchar("winner_variant", { length: 1 }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
    sendingStartedAt: timestamp("sending_started_at", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    recipientCount: integer("recipient_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    lastError: text("last_error"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("campaigns_store_status_idx").on(table.storeId, table.status),
    index("campaigns_scheduled_idx")
      .on(table.scheduledAt)
      .where(sql`status = 'SCHEDULED' AND scheduled_at IS NOT NULL`),
  ],
);

/**
 * One row per campaign recipient (M6). unique(campaignId, destination)
 * dedupes the audience (two customers sharing an email get ONE message).
 * State machine: PENDING → SENT | FAILED | SKIPPED (skipped = suppressed or
 * destination missing).
 */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => shopifyCustomers.id, {
      onDelete: "set null",
    }),
    /** Email address or E.164 phone the message goes to. */
    destination: varchar("destination", { length: 320 }).notNull(),
    variant: varchar("variant", { length: 1 }).notNull().default("A"),
    status: campaignRecipientStatusEnum("status")
      .notNull()
      .default(CampaignRecipientStatus.Pending),
    attempts: integer("attempts").notNull().default(0),
    providerRef: varchar("provider_ref", { length: 120 }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("campaign_recipients_campaign_destination_unique").on(
      table.campaignId,
      table.destination,
    ),
    index("campaign_recipients_campaign_status_idx").on(table.campaignId, table.status),
    index("campaign_recipients_store_idx").on(table.storeId),
  ],
);

/**
 * Trackable message events (M6). SENT/FAILED are written by the sender;
 * OPENED/CLICKED/UNSUBSCRIBED arrive via the public tracking endpoints and
 * are written through the owner role (no tenant context exists there — the
 * signed token IS the authorization, see M6 doc §5).
 */
export const messageEvents = pgTable(
  "message_events",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => campaignRecipients.id, { onDelete: "cascade" }),
    kind: messageEventKindEnum("kind").notNull(),
    /** Click target URL (CLICKED only). */
    url: text("url"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    index("message_events_recipient_idx").on(table.recipientId),
    index("message_events_campaign_kind_idx").on(table.campaignId, table.kind),
    index("message_events_store_idx").on(table.storeId),
  ],
);

/**
 * Per-store suppression list (M6 compliance: CAN-SPAM/GDPR). Any destination
 * here is skipped by campaign sends AND workflow email/sms actions. Added by
 * the unsubscribe endpoint, bounces, or support operators; never deleted
 * (un-subscribing happens by removing the row via support action only).
 */
export const messageSuppressions = pgTable(
  "message_suppressions",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    channel: messageChannelEnum("channel").notNull(),
    destination: varchar("destination", { length: 320 }).notNull(),
    reason: varchar("reason", { length: 40 }).notNull(),
    /** Merchant-facing note (e.g. which campaign the unsubscribe came from). */
    note: text("note"),
  },
  (table) => [
    uniqueIndex("message_suppressions_store_channel_destination_unique").on(
      table.storeId,
      table.channel,
      table.destination,
    ),
  ],
);

/**
 * Report files requested by merchants (M6). The generated bytes live in the
 * row itself (bytea, capped by EXPORT_MAX_ROWS/format limits — the platform
 * has no object storage dependency at this scale; the expires_at sweep
 * reclaims space). Downloads stream through the API with auth + tenant scope.
 */
export const exportsTable = pgTable(
  "exports",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: exportKindEnum("kind").notNull(),
    format: exportFormatEnum("format").notNull(),
    status: exportStatusEnum("status").notNull().default(ExportStatus.Queued),
    /** Filter params (date range, entity filters) — replayable provenance. */
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    fileName: varchar("file_name", { length: 220 }),
    fileData: bytea("file_data"),
    rowCount: integer("row_count"),
    sizeBytes: integer("size_bytes"),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("exports_store_created_idx").on(table.storeId, table.createdAt),
    index("exports_expiry_idx")
      .on(table.expiresAt)
      .where(sql`status = 'READY' AND expires_at IS NOT NULL`),
  ],
);

/** Merchant ↔ operator support threads (M6). Counters maintained on insert (single tx). */
export const supportTickets = pgTable(
  "support_tickets",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    openedByUserId: uuid("opened_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    subject: varchar("subject", { length: 200 }).notNull(),
    category: supportTicketCategoryEnum("category").notNull(),
    priority: supportTicketPriorityEnum("priority")
      .notNull()
      .default(SupportTicketPriority.Normal),
    status: supportTicketStatusEnum("status").notNull().default(SupportTicketStatus.Open),
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "date" }),
    /** Operator identity (email) currently handling the thread, if any. */
    assignedOperator: varchar("assigned_operator", { length: 200 }),
    /** Platform-side unread marker (a merchant reply flips it true). */
    operatorAttention: boolean("operator_attention").notNull().default(true),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("support_tickets_store_status_idx").on(table.storeId, table.status),
    index("support_tickets_operator_idx").on(table.operatorAttention, table.status),
  ],
);

/** Append-only ticket messages (M6) — no edit/delete, the thread is the record. */
export const supportTicketMessages = pgTable(
  "support_ticket_messages",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    authorKind: ticketAuthorKindEnum("author_kind").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Operator identity when authorKind = OPERATOR (email from the step-up session). */
    authorOperator: varchar("author_operator", { length: 200 }),
    body: text("body").notNull(),
  },
  (table) => [
    index("support_ticket_messages_ticket_idx").on(table.ticketId, table.createdAt),
    index("support_ticket_messages_store_idx").on(table.storeId),
  ],
);

/**
 * Support-granted access overrides (M6, from the M5 deferred list). An active
 * row (revoked_at null, access_until in the future) unlocks revenue actions
 * regardless of subscription state — BillingService consults it in both gate
 * choke points. Every grant/revoke is an audited platform-admin action.
 */
export const accessOverrides = pgTable(
  "access_overrides",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    kind: accessOverrideKindEnum("kind").notNull().default(AccessOverrideKind.CompAccess),
    accessUntil: timestamp("access_until", { withTimezone: true, mode: "date" }).notNull(),
    reason: text("reason").notNull(),
    grantedBy: varchar("granted_by", { length: 200 }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedBy: varchar("revoked_by", { length: 200 }),
    revokeReason: text("revoke_reason"),
  },
  (table) => [
    index("access_overrides_store_active_idx")
      .on(table.storeId, table.accessUntil)
      .where(sql`revoked_at IS NULL`),
  ],
);

/**
 * Platform-admin write ledger (M6 step-up auth). Platform table: RLS enabled
 * with NO tenant policy — the restricted profit_app role can never read or
 * write it; only the owner role (admin module) reaches these rows. Every
 * write action (trial extension, override grant/revoke, ticket transitions)
 * appends exactly one row with the operator identity + payload hash.
 */
export const platformAdminActions = pgTable(
  "platform_admin_actions",
  {
    ...baseColumns,
    /** Target store when the action is store-bound (null for global actions). */
    storeId: uuid("store_id"),
    operatorId: varchar("operator_id", { length: 200 }).notNull(),
    action: varchar("action", { length: 120 }).notNull(),
    targetType: varchar("target_type", { length: 60 }).notNull(),
    targetId: varchar("target_id", { length: 120 }).notNull(),
    /** SHA-256 of the canonical request payload (tamper-evident provenance). */
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    ip: varchar("ip", { length: 64 }),
  },
  (table) => [
    index("platform_admin_actions_store_idx").on(table.storeId, table.createdAt),
    index("platform_admin_actions_action_idx").on(table.action, table.createdAt),
  ],
);
