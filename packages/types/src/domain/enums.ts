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
