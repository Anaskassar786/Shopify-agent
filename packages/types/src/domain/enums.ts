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
} as const;
export type SubscriptionStatus =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/** Sync engine (P2). */
export const SyncModule = {
  Products: "PRODUCTS",
  Customers: "CUSTOMERS",
  Orders: "ORDERS",
  Inventory: "INVENTORY",
  Collections: "COLLECTIONS",
  Discounts: "DISCOUNTS",
  Metafields: "METAFIELDS",
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
  InventoryLevelsUpdate: "inventory_levels/update",
  FulfillmentsCreate: "fulfillments/create",
  RefundsCreate: "refunds/create",
  CheckoutsCreate: "checkouts/create",
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
