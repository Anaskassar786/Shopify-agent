/**
 * Domain enumerations — the ONLY place these strings may be declared (P1: "No magic strings").
 * Pattern: const object + union type, so values are usable at runtime and in types.
 *
 * Sources: P2 (roles, lifecycle), P3 (automation modes), P10 (confidence/action status),
 * P12 (extended roles). Merges are deliberate reconciliations recorded in part notes.
 */

/** Runtime environments. */
export const Environment = {
  Development: "development",
  Test: "test",
  Staging: "staging",
  Production: "production",
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

/** RBAC roles — union of P2 (merchant roles) and P12 (platform-extended roles). */
export const UserRole = {
  Owner: "OWNER",
  Admin: "ADMIN",
  Manager: "MANAGER",
  Staff: "STAFF",
  Analyst: "ANALYST",
  Support: "SUPPORT",
  Viewer: "VIEWER",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const UserStatus = {
  Active: "ACTIVE",
  Invited: "INVITED",
  Suspended: "SUSPENDED",
  Deleted: "DELETED",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const StoreStatus = {
  Active: "ACTIVE",
  Suspended: "SUSPENDED",
  Uninstalled: "UNINSTALLED",
} as const;
export type StoreStatus = (typeof StoreStatus)[keyof typeof StoreStatus];

/** Subscription plans (P7/P11). Enterprise/Custom are contract-priced. */
export const PlanCode = {
  Starter: "STARTER",
  Growth: "GROWTH",
  Professional: "PROFESSIONAL",
  Enterprise: "ENTERPRISE",
  Custom: "CUSTOM",
} as const;
export type PlanCode = (typeof PlanCode)[keyof typeof PlanCode];

/** Subscription lifecycle (P2). */
export const SubscriptionStatus = {
  Trialing: "TRIALING",
  TrialExpired: "TRIAL_EXPIRED",
  Active: "ACTIVE",
  PastDue: "PAST_DUE",
  Cancelled: "CANCELLED",
  Expired: "EXPIRED",
  Suspended: "SUSPENDED",
  /** M5: charge created in Shopify, awaiting the merchant's acceptance. */
  ChargePending: "CHARGE_PENDING",
} as const;
export type SubscriptionStatus =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/** Billing charge cadence (P2: monthly · yearly). */
export const BillingInterval = {
  Monthly: "MONTHLY",
  Yearly: "YEARLY",
} as const;
export type BillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];

/** Usage meters with plan quotas (P2 usage-based readiness; seeds in plans.entitlements.quotas). */
export const UsageMeter = {
  AiCalls: "AI_CALLS",
  EmailsSent: "EMAILS_SENT",
  SmsSent: "SMS_SENT",
  AutomationRuns: "AUTOMATION_RUNS",
} as const;
export type UsageMeter = (typeof UsageMeter)[keyof typeof UsageMeter];

/**
 * Billing lifecycle ledger (P2 lifecycle + charge events). Append-only — the
 * audit-grade source for the merchant's billing history (amendment recorded in
 * the M5 doc: supersedes P2's invoices/payments rows, which have no honest API).
 */
export const BillingEventType = {
  TrialStarted: "TRIAL_STARTED",
  TrialNudgeSent: "TRIAL_NUDGE_SENT",
  TrialExpired: "TRIAL_EXPIRED",
  /** M6: operator-extended trial window (platform-admin write action). */
  TrialExtended: "TRIAL_EXTENDED",
  ChargeCreated: "CHARGE_CREATED",
  ChargeAccepted: "CHARGE_ACCEPTED",
  ChargeDeclined: "CHARGE_DECLINED",
  ChargeCancelled: "CHARGE_CANCELLED",
  ChargeReconciled: "CHARGE_RECONCILED",
  PlanChanged: "PLAN_CHANGED",
  SubscriptionSuspended: "SUBSCRIPTION_SUSPENDED",
  SubscriptionReactivated: "SUBSCRIPTION_REACTIVATED",
} as const;
export type BillingEventType = (typeof BillingEventType)[keyof typeof BillingEventType];

/**
 * Engagement & activation-funnel events (P11). First-time milestone kinds are
 * deduped per store via a partial unique index — funnels never double-count.
 * Repeatable kinds (nudges, views) carry no dedupe guarantee by design.
 */
export const EngagementEventKind = {
  StoreConnected: "STORE_CONNECTED",
  FirstSyncCompleted: "FIRST_SYNC_COMPLETED",
  FirstAiRunCompleted: "FIRST_AI_RUN_COMPLETED",
  FirstAiInsightViewed: "FIRST_AI_INSIGHT_VIEWED",
  FirstRecommendationApproved: "FIRST_RECOMMENDATION_APPROVED",
  FirstAutomationEnabled: "FIRST_AUTOMATION_ENABLED",
  UpgradeViewed: "UPGRADE_VIEWED",
  PaidSubscriptionStarted: "PAID_SUBSCRIPTION_STARTED",
  TrialNudgeSent: "TRIAL_NUDGE_SENT",
  ChurnNudgeSent: "CHURN_NUDGE_SENT",
  /** M6: first DAG workflow activated from the Automation Center. */
  FirstWorkflowActivated: "FIRST_WORKFLOW_ACTIVATED",
  /** M6: first campaign fully dispatched to its audience. */
  FirstCampaignSent: "FIRST_CAMPAIGN_SENT",
} as const;
export type EngagementEventKind =
  (typeof EngagementEventKind)[keyof typeof EngagementEventKind];

/** Kinds deduped to one row per store — the funnel milestones (P11 activation metric). */
export const ENGAGEMENT_MILESTONE_KINDS: readonly EngagementEventKind[] = [
  EngagementEventKind.StoreConnected,
  EngagementEventKind.FirstSyncCompleted,
  EngagementEventKind.FirstAiRunCompleted,
  EngagementEventKind.FirstAiInsightViewed,
  EngagementEventKind.FirstRecommendationApproved,
  EngagementEventKind.FirstAutomationEnabled,
  EngagementEventKind.PaidSubscriptionStarted,
  EngagementEventKind.FirstWorkflowActivated,
  EngagementEventKind.FirstCampaignSent,
];

/** Sync engine (P2). CHECKOUTS added in M4 — the abandoned-cart data plane. */
export const SyncModule = {
  Products: "PRODUCTS",
  Customers: "CUSTOMERS",
  Orders: "ORDERS",
  Inventory: "INVENTORY",
  Collections: "COLLECTIONS",
  Discounts: "DISCOUNTS",
  Metafields: "METAFIELDS",
  Checkouts: "CHECKOUTS",
} as const;
export type SyncModule = (typeof SyncModule)[keyof typeof SyncModule];

export const SyncMode = {
  Full: "FULL",
  Incremental: "INCREMENTAL",
  Manual: "MANUAL",
  Scheduled: "SCHEDULED",
} as const;
export type SyncMode = (typeof SyncMode)[keyof typeof SyncMode];

export const SyncStatus = {
  Pending: "PENDING",
  Running: "RUNNING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
} as const;
export type SyncStatus = (typeof SyncStatus)[keyof typeof SyncStatus];

/** Webhook processing (P2/P12: retry + duplicate prevention). */
export const WebhookStatus = {
  Received: "RECEIVED",
  Processed: "PROCESSED",
  Duplicate: "DUPLICATE",
  Failed: "FAILED",
} as const;
export type WebhookStatus = (typeof WebhookStatus)[keyof typeof WebhookStatus];

/** Recommendation state machine (P3/P10). Transitions are enforced, never free-form. */
export const RecommendationStatus = {
  PendingApproval: "PENDING_APPROVAL",
  Approved: "APPROVED",
  Rejected: "REJECTED",
  Scheduled: "SCHEDULED",
  Executing: "EXECUTING",
  Executed: "EXECUTED",
  Failed: "FAILED",
  Expired: "EXPIRED",
  Measured: "MEASURED",
} as const;
export type RecommendationStatus =
  (typeof RecommendationStatus)[keyof typeof RecommendationStatus];

export const Priority = {
  Low: "LOW",
  Medium: "MEDIUM",
  High: "HIGH",
  Critical: "CRITICAL",
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const RiskLevel = {
  Low: "LOW",
  Medium: "MEDIUM",
  High: "HIGH",
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

/** Automation (P3). */
export const AutomationMode = {
  Manual: "MANUAL",
  SemiAutomatic: "SEMI_AUTOMATIC",
  FullyAutomatic: "FULLY_AUTOMATIC",
} as const;
export type AutomationMode = (typeof AutomationMode)[keyof typeof AutomationMode];

export const AutomationStatus = {
  Enabled: "ENABLED",
  Disabled: "DISABLED",
  Paused: "PAUSED",
  Running: "RUNNING",
  Failed: "FAILED",
} as const;
export type AutomationStatus =
  (typeof AutomationStatus)[keyof typeof AutomationStatus];

/** Background jobs (P3/P5). */
export const JobStatus = {
  Queued: "QUEUED",
  Running: "RUNNING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  DeadLettered: "DEAD_LETTERED",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const QueueName = {
  Ai: "ai",
  Sync: "sync",
  Email: "email",
  Sms: "sms",
  Discount: "discount",
  Analytics: "analytics",
  Notification: "notification",
  Cleanup: "cleanup",
  /** M6: workflow runs + campaign dispatch/send fan-out. */
  Automation: "automation",
  /** M6: report file generation (CSV/XLSX/PDF). */
  Export: "export",
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/** Notifications (P4). */
export const NotificationCategory = {
  Ai: "AI",
  Orders: "ORDERS",
  Inventory: "INVENTORY",
  Billing: "BILLING",
  Security: "SECURITY",
  Automation: "AUTOMATION",
  System: "SYSTEM",
} as const;
export type NotificationCategory =
  (typeof NotificationCategory)[keyof typeof NotificationCategory];

/** AI layer (P10). */
export const AiAgentId = {
  BusinessAnalyst: "BUSINESS_ANALYST",
  CustomerIntelligence: "CUSTOMER_INTELLIGENCE",
  RevenueRecovery: "REVENUE_RECOVERY",
  ProductIntelligence: "PRODUCT_INTELLIGENCE",
  Inventory: "INVENTORY",
} as const;
export type AiAgentId = (typeof AiAgentId)[keyof typeof AiAgentId];

/** Model tiers for cost optimization (P10). */
export const ModelTier = {
  Triage: "TRIAGE",
  Standard: "STANDARD",
  Deep: "DEEP",
} as const;
export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

export const AiProviderId = {
  Gemini: "GEMINI",
  OpenAi: "OPENAI",
  Claude: "CLAUDE",
  Local: "LOCAL",
} as const;
export type AiProviderId = (typeof AiProviderId)[keyof typeof AiProviderId];

/**
 * Recommendation taxonomy (P3 example list, v1 slice). Each type is produced
 * by exactly one agent + rule pairing in the catalog — the engine can never
 * emit an untraceable recommendation.
 */
export const RecommendationType = {
  RecoverAbandonedCart: "RECOVER_ABANDONED_CART",
  Restock: "RESTOCK",
  RemoveDeadStock: "REMOVE_DEAD_STOCK",
  TargetVip: "TARGET_VIP",
  WinbackInactive: "WINBACK_INACTIVE",
  LaunchPromotion: "LAUNCH_PROMOTION",
  ReduceRefundRisk: "REDUCE_REFUND_RISK",
  RevenueDeclineReview: "REVENUE_DECLINE_REVIEW",
} as const;
export type RecommendationType =
  (typeof RecommendationType)[keyof typeof RecommendationType];

/**
 * Executable action attached to a recommendation (P10 action shape).
 * ADVISORY carries no v1 tool: approval records the merchant's decision and
 * notifies — the platform never fakes an external side effect.
 */
export const ActionType = {
  SendRecoveryEmail: "SEND_RECOVERY_EMAIL",
  CreateDiscountCode: "CREATE_DISCOUNT_CODE",
  Advisory: "ADVISORY",
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

/** What kicked off an engine run (P10 scheduled + real-time triggers). */
export const AiRunTrigger = {
  Scheduled: "SCHEDULED",
  Manual: "MANUAL",
  Event: "EVENT",
} as const;
export type AiRunTrigger = (typeof AiRunTrigger)[keyof typeof AiRunTrigger];

/** Run ledger outcome. PROVIDER_UNAVAILABLE is the P3 failsafe, not an error. */
export const AiRunStatus = {
  Completed: "COMPLETED",
  ProviderUnavailable: "PROVIDER_UNAVAILABLE",
  Failed: "FAILED",
} as const;
export type AiRunStatus = (typeof AiRunStatus)[keyof typeof AiRunStatus];

/** Single provider call outcome (P10 per-call logging). */
export const AiCallStatus = {
  Succeeded: "SUCCEEDED",
  Failed: "FAILED",
} as const;
export type AiCallStatus = (typeof AiCallStatus)[keyof typeof AiCallStatus];

/** Tool execution ledger (action_executions). */
export const ExecutionStatus = {
  Pending: "PENDING",
  Running: "RUNNING",
  Succeeded: "SUCCEEDED",
  Failed: "FAILED",
} as const;
export type ExecutionStatus = (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

/** How attributed revenue was linked to an executed action (deterministic). */
export const AttributionMethod = {
  CheckoutToken: "CHECKOUT_TOKEN",
  DiscountCode: "DISCOUNT_CODE",
  CustomerWindow: "CUSTOMER_WINDOW",
} as const;
export type AttributionMethod =
  (typeof AttributionMethod)[keyof typeof AttributionMethod];

/** Recommendation event taxonomy — the append-only audit trail (P3). */
export const RecommendationEventType = {
  Created: "CREATED",
  Approved: "APPROVED",
  Rejected: "REJECTED",
  AutoApproved: "AUTO_APPROVED",
  ExecutionQueued: "EXECUTION_QUEUED",
  Executed: "EXECUTED",
  ExecutionFailed: "EXECUTION_FAILED",
  Expired: "EXPIRED",
  Measured: "MEASURED",
} as const;
export type RecommendationEventType =
  (typeof RecommendationEventType)[keyof typeof RecommendationEventType];

export const EventActorType = {
  Merchant: "MERCHANT",
  System: "SYSTEM",
  Ai: "AI",
} as const;
export type EventActorType = (typeof EventActorType)[keyof typeof EventActorType];

/** Catalog entity states mirrored from Shopify Admin (P2 data plane). */
export const ProductStatus = {
  Active: "ACTIVE",
  Draft: "DRAFT",
  Archived: "ARCHIVED",
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

export const CollectionType = {
  Custom: "CUSTOM",
  Smart: "SMART",
} as const;
export type CollectionType = (typeof CollectionType)[keyof typeof CollectionType];

/** Polymorphic metafield ownership (one table, many parent resources). */
export const MetafieldOwnerType = {
  Shop: "SHOP",
  Product: "PRODUCT",
  ProductVariant: "PRODUCT_VARIANT",
  Collection: "COLLECTION",
  Customer: "CUSTOMER",
  Order: "ORDER",
} as const;
export type MetafieldOwnerType =
  (typeof MetafieldOwnerType)[keyof typeof MetafieldOwnerType];

/**
 * Shopify webhook topics registered by the app (P2 list) PLUS the three
 * mandatory GDPR/compliance topics required for App Store distribution.
 */
export const ShopifyWebhookTopic = {
  AppUninstalled: "app/uninstalled",
  OrdersCreate: "orders/create",
  OrdersUpdated: "orders/updated",
  OrdersPaid: "orders/paid",
  OrdersCancelled: "orders/cancelled",
  CustomersCreate: "customers/create",
  CustomersUpdate: "customers/update",
  CustomersDelete: "customers/delete",
  ProductsCreate: "products/create",
  ProductsUpdate: "products/update",
  ProductsDelete: "products/delete",
  CollectionsCreate: "collections/create",
  CollectionsUpdate: "collections/update",
  CollectionsDelete: "collections/delete",
  DiscountsCreate: "discounts/create",
  DiscountsUpdate: "discounts/update",
  DiscountsDelete: "discounts/delete",
  InventoryLevelsUpdate: "inventory_levels/update",
  FulfillmentsCreate: "fulfillments/create",
  RefundsCreate: "refunds/create",
  CheckoutsCreate: "checkouts/create",
  CheckoutsUpdate: "checkouts/update",
  /** Mandatory compliance topics (App Review requirement). */
  CustomersDataRequest: "customers/data_request",
  CustomersRedact: "customers/redact",
  ShopRedact: "shop/redact",
} as const;
export type ShopifyWebhookTopic =
  (typeof ShopifyWebhookTopic)[keyof typeof ShopifyWebhookTopic];

export const AuditResult = {
  Success: "SUCCESS",
  Failure: "FAILURE",
} as const;
export type AuditResult = (typeof AuditResult)[keyof typeof AuditResult];

export const HealthStatus = {
  Ok: "ok",
  Degraded: "degraded",
  Down: "down",
} as const;
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

/* ─────────────────────────── M6: Automation Center + Campaigns ─────────────────────────── */

/** DAG workflow lifecycle (M6). Only ACTIVE workflows consume triggers/schedules. */
export const WorkflowStatus = {
  Draft: "DRAFT",
  Active: "ACTIVE",
  Paused: "PAUSED",
  Archived: "ARCHIVED",
} as const;
export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

/** What fires a workflow run (M6). EVENT = a Shopify webhook topic, matched after processing. */
export const WorkflowTriggerKind = {
  Manual: "MANUAL",
  Schedule: "SCHEDULE",
  Event: "EVENT",
} as const;
export type WorkflowTriggerKind =
  (typeof WorkflowTriggerKind)[keyof typeof WorkflowTriggerKind];

/** Node taxonomy of the workflow DAG (M6). Exactly one TRIGGER root per workflow. */
export const WorkflowNodeKind = {
  Trigger: "TRIGGER",
  Condition: "CONDITION",
  Delay: "DELAY",
  SendEmail: "SEND_EMAIL",
  SendSms: "SEND_SMS",
  TagCustomer: "TAG_CUSTOMER",
  CreateDiscount: "CREATE_DISCOUNT",
} as const;
export type WorkflowNodeKind = (typeof WorkflowNodeKind)[keyof typeof WorkflowNodeKind];

/** Run ledger outcome. WAITING = suspended on a DELAY node until resumeAt. */
export const WorkflowRunStatus = {
  Running: "RUNNING",
  Waiting: "WAITING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
} as const;
export type WorkflowRunStatus = (typeof WorkflowRunStatus)[keyof typeof WorkflowRunStatus];

/** Per-node step checkpoint (M6 idempotent resume; unique per run+node). */
export const WorkflowStepStatus = {
  Pending: "PENDING",
  Running: "RUNNING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Skipped: "SKIPPED",
} as const;
export type WorkflowStepStatus =
  (typeof WorkflowStepStatus)[keyof typeof WorkflowStepStatus];

/** Outbound message rails (M6 templates/campaigns/trackable messages). */
export const MessageChannel = {
  Email: "EMAIL",
  Sms: "SMS",
} as const;
export type MessageChannel = (typeof MessageChannel)[keyof typeof MessageChannel];

/** Campaign lifecycle (M6): DRAFT → SCHEDULED → SENDING → SENT | FAILED; cancellable pre-send. */
export const CampaignStatus = {
  Draft: "DRAFT",
  Scheduled: "SCHEDULED",
  Sending: "SENDING",
  Sent: "SENT",
  Cancelled: "CANCELLED",
  Failed: "FAILED",
} as const;
export type CampaignStatus = (typeof CampaignStatus)[keyof typeof CampaignStatus];

/** Built-in recipient selectors (M6 v1 — segments beyond these ship with growth analytics v2). */
export const CampaignAudience = {
  AllCustomers: "ALL_CUSTOMERS",
  MarketingOptIn: "MARKETING_OPT_IN",
  RepeatCustomers: "REPEAT_CUSTOMERS",
} as const;
export type CampaignAudience = (typeof CampaignAudience)[keyof typeof CampaignAudience];

/** Per-recipient delivery state (M6). SKIPPED = suppressed/unsubscribed or missing destination. */
export const CampaignRecipientStatus = {
  Pending: "PENDING",
  Sent: "SENT",
  Failed: "FAILED",
  Skipped: "SKIPPED",
} as const;
export type CampaignRecipientStatus =
  (typeof CampaignRecipientStatus)[keyof typeof CampaignRecipientStatus];

/** Trackable message events (M6). SENT/FAILED from the rail; OPENED/CLICKED/UNSUBSCRIBED from tracking endpoints. */
export const MessageEventKind = {
  Sent: "SENT",
  Failed: "FAILED",
  Opened: "OPENED",
  Clicked: "CLICKED",
  Unsubscribed: "UNSUBSCRIBED",
} as const;
export type MessageEventKind = (typeof MessageEventKind)[keyof typeof MessageEventKind];

/** Report families the export engine can materialize (M6). */
export const ExportKind = {
  AuditLogs: "AUDIT_LOGS",
  Customers: "CUSTOMERS",
  Orders: "ORDERS",
  Products: "PRODUCTS",
  Recommendations: "RECOMMENDATIONS",
} as const;
export type ExportKind = (typeof ExportKind)[keyof typeof ExportKind];

export const ExportFormat = {
  Csv: "CSV",
  Xlsx: "XLSX",
  Pdf: "PDF",
} as const;
export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat];

export const ExportStatus = {
  Queued: "QUEUED",
  Running: "RUNNING",
  Ready: "READY",
  Failed: "FAILED",
} as const;
export type ExportStatus = (typeof ExportStatus)[keyof typeof ExportStatus];

/** Support ticket lifecycle (M6). RESOLVED keeps the thread; CLOSED is terminal. */
export const SupportTicketStatus = {
  Open: "OPEN",
  WaitingOnCustomer: "WAITING_ON_CUSTOMER",
  Resolved: "RESOLVED",
  Closed: "CLOSED",
} as const;
export type SupportTicketStatus =
  (typeof SupportTicketStatus)[keyof typeof SupportTicketStatus];

export const SupportTicketCategory = {
  Bug: "BUG",
  Billing: "BILLING",
  Data: "DATA",
  Feature: "FEATURE",
  Other: "OTHER",
} as const;
export type SupportTicketCategory =
  (typeof SupportTicketCategory)[keyof typeof SupportTicketCategory];

export const SupportTicketPriority = {
  Low: "LOW",
  Normal: "NORMAL",
  High: "HIGH",
  Urgent: "URGENT",
} as const;
export type SupportTicketPriority =
  (typeof SupportTicketPriority)[keyof typeof SupportTicketPriority];

/** Who wrote a ticket message (M6): the merchant user or a platform operator. */
export const TicketAuthorKind = {
  Merchant: "MERCHANT",
  Operator: "OPERATOR",
} as const;
export type TicketAuthorKind = (typeof TicketAuthorKind)[keyof typeof TicketAuthorKind];

/** Support-granted access override kinds (M6 admin write actions). COMP_ACCESS = comped window. */
export const AccessOverrideKind = {
  CompAccess: "COMP_ACCESS",
} as const;
export type AccessOverrideKind = (typeof AccessOverrideKind)[keyof typeof AccessOverrideKind];

/** Platform-admin write actions (M6) — recorded in platform_admin_actions and the audit trail. */
export const PlatformAdminAction = {
  OpenSession: "platform.admin.session.open",
  ExtendTrial: "platform.admin.trial.extend",
  GrantAccessOverride: "platform.admin.access-override.grant",
  RevokeAccessOverride: "platform.admin.access-override.revoke",
  ReplyTicket: "platform.admin.ticket.reply",
  ResolveTicket: "platform.admin.ticket.resolve",
  CloseTicket: "platform.admin.ticket.close",
} as const;
export type PlatformAdminAction =
  (typeof PlatformAdminAction)[keyof typeof PlatformAdminAction];

/** Condition-node operands (M6): paths resolved against the workflow run subject. */
export const ConditionField = {
  CustomerOrdersCount: "customer.ordersCount",
  CustomerTotalSpentCents: "customer.totalSpentCents",
  CustomerAcceptsMarketing: "customer.acceptsMarketing",
  CustomerTag: "customer.tag",
  EventTotalCents: "event.totalCents",
  EventCurrency: "event.currency",
} as const;
export type ConditionField = (typeof ConditionField)[keyof typeof ConditionField];

export const ConditionOperator = {
  Equals: "EQ",
  NotEquals: "NEQ",
  GreaterThan: "GT",
  GreaterThanOrEqual: "GTE",
  LessThan: "LT",
  LessThanOrEqual: "LTE",
  Contains: "CONTAINS",
} as const;
export type ConditionOperator =
  (typeof ConditionOperator)[keyof typeof ConditionOperator];

/** A/B variant labels (M6 campaigns). */
export const CampaignVariant = {
  A: "A",
  B: "B",
} as const;
export type CampaignVariant = (typeof CampaignVariant)[keyof typeof CampaignVariant];

/** Why a destination is suppressed (M6 compliance ledger). */
export const MessageSuppressionReason = {
  Unsubscribed: "UNSUBSCRIBED",
  Complaint: "COMPLAINT",
  Bounce: "BOUNCE",
  Manual: "MANUAL",
} as const;
export type MessageSuppressionReason =
  (typeof MessageSuppressionReason)[keyof typeof MessageSuppressionReason];

/** Which tracking token authorizes which endpoint (M6). */
export const TrackingTokenKind = {
  Open: "open",
  Click: "click",
  Unsubscribe: "unsubscribe",
} as const;
export type TrackingTokenKind = (typeof TrackingTokenKind)[keyof typeof TrackingTokenKind];
