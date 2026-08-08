import type {
  NotificationCategory,
  NotificationCategory as NC,
  ProductStatus,
  SyncModule,
  SyncStatus,
} from "@profit/types";

/**
 * Wire types for the v1 API — every interface mirrors an API router response
 * EXACTLY (M1–M3 contracts). When a router's response changes, one type
 * error surfaces at the client touchpoint.
 */

/* ── Common envelopes ────────────────────────────────────────────────────── */

export interface Paged<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
}

/* ── Store ───────────────────────────────────────────────────────────────── */

export interface StoreProfile {
  readonly id: string;
  readonly shopDomain: string;
  readonly name: string;
  readonly email: string | null;
  readonly currency: string;
  readonly timezone: string;
  readonly status: string;
  readonly installedAt: string;
}

export interface StoreSettingsRow {
  readonly id: string;
  readonly branding: Record<string, unknown>;
  readonly aiPreferences: Record<string, unknown>;
  readonly automationPreferences: Record<string, unknown>;
  readonly featureOverrides: Record<string, unknown>;
  /** M8: scheduled-report schedule + delivery preferences (jsonb, ADR 34). */
  readonly reportPreferences: ReportPreferencesDto;
  readonly onboardingCompletedAt: string | null;
}

export interface SubscriptionRow {
  readonly id: string;
  readonly status: string;
  readonly trialEndsAt: string | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly planId: string;
  /** M5 billing engine fields (present on every billing-plane wire). */
  readonly shopifyChargeId?: string | null;
  readonly billingInterval?: BillingIntervalValue | null;
  readonly graceEndsAt?: string | null;
  readonly cancelledAt?: string | null;
}

export type BillingIntervalValue = "MONTHLY" | "YEARLY";

/** Parsed + validated at the API edge — the UI renders plan limits from these. */
export interface PlanEntitlements {
  readonly capabilities: readonly string[];
  readonly quotas: {
    readonly aiCalls: number;
    readonly emails: number;
    readonly sms: number;
    readonly automationRuns: number;
    readonly seats: number;
    readonly stores: number;
  };
}

export interface PlanRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly monthlyPriceCents: number;
  readonly yearlyPriceCents: number;
  readonly trialDays: number;
  readonly entitlements: PlanEntitlements;
  readonly isActive?: boolean;
}

export interface StoreResponse {
  readonly store: StoreProfile;
  readonly settings: StoreSettingsRow | null;
  readonly subscription: SubscriptionRow | null;
  /** M7: platform-configured support mailbox shared with the legal plane. */
  readonly supportEmail: string | null;
}

export interface SubscriptionResponse {
  readonly subscription: SubscriptionRow | null;
  readonly plan: PlanRow | null;
}

/* ── Sync ────────────────────────────────────────────────────────────────── */

export interface SyncModuleStatus {
  readonly module: SyncModule;
  readonly status: SyncStatus | "PENDING";
  readonly mode: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly stats: { processed: number; created: number; updated: number; failed: number } | null;
  readonly errorMessage: string | null;
  readonly retryCount: number;
}

export interface SyncStatusResponse {
  readonly storeId: string;
  readonly modules: readonly SyncModuleStatus[];
}

export interface SyncHistoryRow {
  readonly id: string;
  readonly storeId: string;
  readonly module: SyncModule;
  readonly mode: string;
  readonly status: SyncStatus;
  readonly stats: Record<string, number>;
  readonly errorMessage: string | null;
  readonly retryCount: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export interface SyncTriggerResponse {
  readonly module?: SyncModule;
  readonly modules?: readonly SyncModule[];
  readonly jobId?: string;
  readonly runGroupId?: string;
}

/* ── Analytics ───────────────────────────────────────────────────────────── */

export interface AnalyticsTotals {
  readonly ordersCount: number;
  readonly cancelledOrders: number;
  readonly itemsSold: number;
  readonly newCustomers: number;
  readonly returningCustomers: number;
  readonly grossSalesCents: number;
  readonly discountsCents: number;
  readonly refundsCents: number;
  readonly netSalesCents: number;
  readonly taxesCents: number;
  readonly shippingCents: number;
  readonly aovCents: number;
  readonly currency: string;
}

export interface AnalyticsDay {
  readonly date: string;
  readonly ordersCount: number;
  readonly itemsSold: number;
  readonly newCustomers: number;
  readonly netSalesCents: number;
  readonly grossSalesCents: number;
  readonly refundsCents: number;
}

export interface AnalyticsSummaryResponse {
  readonly range: { days: number; since: string };
  readonly totals: AnalyticsTotals;
  readonly series: readonly AnalyticsDay[];
}

export interface TopProductRow {
  readonly productId: string;
  readonly title: string;
  readonly unitsSold: number;
  readonly revenueCents: number;
}

export interface TopCustomerRow {
  readonly customerId: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly ordersCount: number;
  readonly totalSpentCents: number;
}

/* ── Catalog ─────────────────────────────────────────────────────────────── */

export interface ProductRow {
  readonly id: string;
  readonly title: string;
  readonly status: ProductStatus;
  readonly vendor: string | null;
  readonly productType: string | null;
  readonly tags: readonly string[];
  readonly handle: string | null;
  readonly updatedAt: string;
  readonly shopifyUpdatedAt: string | null;
}

export interface VariantRow {
  readonly id: string;
  readonly title: string | null;
  readonly sku: string | null;
  readonly price: string;
  readonly compareAtPrice: string | null;
  readonly inventoryItemId: string | null;
  readonly position: number | null;
  readonly barcode: string | null;
}

/** GET /products/:id — full synced catalog row (additive M3 route). */
export interface ProductDetailRow extends ProductRow {
  readonly shopifyProductId: string;
  readonly bodyHtml: string | null;
  readonly publishedAt: string | null;
  readonly shopifyCreatedAt: string | null;
  readonly createdAt: string;
}

export interface CustomerRow {
  readonly id: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly ordersCount: number;
  readonly totalSpent: string;
  readonly acceptsMarketing: boolean;
  readonly tags: readonly string[];
}

export interface CustomerDetailResponse {
  readonly customer: CustomerRow;
  readonly metrics: {
    readonly ordersCount: number;
    readonly totalSpentCents: number;
    readonly aovCents: number;
    readonly firstOrderAt: string | null;
    readonly lastOrderAt: string | null;
  } | null;
  readonly recentOrders: readonly OrderRow[];
}

export interface OrderRow {
  readonly id: string;
  readonly name: string;
  readonly orderNumber: number | null;
  readonly email: string | null;
  readonly financialStatus: string | null;
  readonly fulfillmentStatus: string | null;
  readonly currency: string;
  readonly totalPrice: string;
  readonly processedAt: string | null;
  readonly createdAt: string;
}

export interface LineItemRow {
  readonly id: string;
  readonly title: string;
  readonly quantity: number;
  readonly price: string;
  readonly sku: string | null;
}

export interface OrderDetailResponse {
  readonly order: OrderRow;
  readonly lineItems: readonly LineItemRow[];
}

export interface InventoryLevelRow {
  readonly id: string;
  readonly available: number;
  readonly locationName: string;
  readonly sku: string | null;
  readonly variantTitle: string | null;
  readonly productTitle: string;
  readonly updatedAt: string;
}

/* ── Notifications ───────────────────────────────────────────────────────── */

export interface NotificationRow {
  readonly id: string;
  readonly storeId: string;
  readonly userId: string | null;
  readonly category: NotificationCategory;
  readonly title: string;
  readonly body: string;
  readonly actionUrl: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

/* ── Search / Audit ──────────────────────────────────────────────────────── */

export interface SearchGroup<T> {
  readonly permitted: boolean;
  readonly total: number;
  readonly items: readonly T[];
}

export interface GlobalSearchResponse {
  readonly query: string;
  readonly groups: {
    readonly products: SearchGroup<{ id: string; title: string; status: string; handle: string | null }>;
    readonly customers: SearchGroup<{ id: string; email: string | null; name: string }>;
    readonly orders: SearchGroup<{ id: string; name: string; email: string | null; financialStatus: string | null }>;
  };
}

export interface AuditLogRow {
  readonly id: string;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly result: "SUCCESS" | "FAILURE";
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly userId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export const NotificationCategories = {
  Ai: "AI",
  Orders: "ORDERS",
  Inventory: "INVENTORY",
  Billing: "BILLING",
  Security: "SECURITY",
  Automation: "AUTOMATION",
  System: "SYSTEM",
} as const satisfies Record<string, NC>;

/* ── AI revenue loop (M4) ────────────────────────────────────────────────── */

export interface RecommendationRow {
  readonly id: string;
  readonly storeId: string;
  readonly type: string;
  readonly agentId: string;
  readonly ruleId: string;
  readonly title: string;
  readonly description: string;
  readonly reasoning: readonly string[];
  readonly priority: string;
  readonly confidence: number;
  readonly riskLevel: string;
  readonly estimatedRevenueCents: number;
  readonly estimatedCostCents: number;
  readonly subjects: unknown;
  readonly actionType: string;
  readonly actionParams: unknown;
  readonly status: string;
  readonly stateVersion: number;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

/** Immutable evidence snapshot written with the recommendation (P10 explainability). */
export interface EvidenceSnapshot {
  readonly computedAt: string;
  readonly storeHealthScore: number;
  readonly facts: readonly string[];
  readonly rule: { readonly id: string; readonly version: number };
  readonly estimates: {
    readonly revenueCents: number;
    readonly costCents: number;
    readonly roiMultiple: number | null;
    readonly expectationBasis: string;
  };
  readonly calibration: {
    readonly modelConfidence: number;
    readonly finalConfidence: number;
    readonly tier: string;
    readonly modelPriority: string;
    readonly finalPriority: string;
    readonly modelRisk: string;
    readonly finalRisk: string;
  };
  readonly contextDigest: {
    readonly netCents: number;
    readonly trendPct: number;
    readonly ordersCount: number;
    readonly customersTotal: number;
    readonly abandonedCount: number;
    readonly refundsRatePct: number;
  };
  readonly model: {
    readonly provider: string | null;
    readonly promptId: string;
    readonly promptVersion: string;
  };
}

export interface RecommendationEventRow {
  readonly id: string;
  readonly event: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly details: unknown;
  readonly createdAt: string;
}

export interface ActionExecutionRow {
  readonly id: string;
  readonly actionType: string;
  readonly status: string;
  readonly actionPreview: unknown;
  readonly toolRef: unknown;
  readonly errorMessage: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface RecommendationDetail extends RecommendationRow {
  readonly evidence: EvidenceSnapshot | null;
  readonly events: readonly RecommendationEventRow[];
  readonly executions: readonly ActionExecutionRow[];
}

export interface HealthComponentRow {
  readonly key: string;
  readonly label: string;
  readonly score: number;
  readonly weight: number;
  readonly reason: string;
}

export interface AiOverviewResponse {
  readonly engine: {
    readonly lastRunAt: string | null;
    readonly lastRunStatus: string | null;
    readonly lastRunTrigger: string | null;
    readonly runsLast7d: number;
    readonly costMicrosLast7d: number;
    readonly tokensLast7d: number;
  };
  readonly health: {
    readonly score: number | null;
    readonly computedAt: string | null;
    readonly components: { readonly components: readonly HealthComponentRow[] } | null;
  };
  readonly open: {
    readonly pendingApproval: number;
    readonly approved: number;
    readonly executing: number;
    readonly highPriorityOpen: number;
  };
  readonly outcomes: {
    readonly acceptanceRatePct: number | null;
    readonly attributedRevenueCents: number;
    readonly attributedOrders: number;
  };
  readonly recentEvents: readonly {
    readonly id: string;
    readonly recommendationId: string;
    readonly event: string;
    readonly actorType: string;
    readonly title: string;
    readonly type: string;
    readonly createdAt: string;
  }[];
}

export interface AutomationPolicyRow {
  readonly mode: "MANUAL" | "SEMI_AUTOMATIC" | "FULLY_AUTOMATIC";
  readonly abandonedCartEnabled: boolean;
  readonly abandonedCartDelayHours: number;
  readonly abandonedCartMinValueCents: number;
  readonly abandonedCartDiscountPercent: number;
  readonly maxAutoDiscountPercent: number;
  readonly maxAutoApproveEstimatedRevenueCents: number;
}

export interface AutomationOverviewResponse {
  readonly policy: AutomationPolicyRow;
  readonly executions: readonly {
    readonly id: string;
    readonly recommendationId: string;
    readonly recommendationTitle: string;
    readonly type: string;
    readonly actionType: string;
    readonly status: string;
    readonly errorMessage: string | null;
    readonly attempts: number;
    readonly preview: unknown;
    readonly createdAt: string;
    readonly finishedAt: string | null;
  }[];
  readonly outcomes: {
    readonly attributedRevenueCents: number;
    readonly attributedOrders: number;
    readonly measuredCount: number;
  };
}

/* ── Billing & growth plane (M5) ─────────────────────────────────────────── */

export interface UsageMeterRow {
  readonly meter: "AI_CALLS" | "EMAILS_SENT" | "SMS_SENT" | "AUTOMATION_RUNS";
  readonly used: number;
  readonly limit: number;
  /** null when the plan does not cap the meter (unlimited or no plan). */
  readonly percentUsed: number | null;
}

export interface BillingUsageSummary {
  readonly window: { readonly from: string; readonly to: string };
  readonly meters: readonly UsageMeterRow[];
  readonly entitlements: PlanEntitlements | null;
  readonly status: string | null;
}

export interface BillingAccessState {
  readonly revenueActionsAllowed: boolean;
  readonly blockedReason: string | null;
}

/** GET /billing/overview — subscription state + live usage bundle + access gate. */
export interface BillingOverviewResponse {
  readonly subscription: SubscriptionRow | null;
  readonly plan: PlanRow | null;
  readonly usage: BillingUsageSummary;
  readonly access: BillingAccessState;
}

/** GET /billing/plans — active catalog + the store's current plan id. */
export interface PlansCatalogResponse {
  readonly currentPlanId: string | null;
  readonly plans: readonly PlanRow[];
}

export type BillingEventTypeValue =
  | "TRIAL_STARTED"
  | "TRIAL_NUDGE_SENT"
  | "TRIAL_EXPIRED"
  | "CHARGE_CREATED"
  | "CHARGE_ACCEPTED"
  | "CHARGE_DECLINED"
  | "CHARGE_CANCELLED"
  | "CHARGE_RECONCILED"
  | "PLAN_CHANGED"
  | "SUBSCRIPTION_SUSPENDED"
  | "SUBSCRIPTION_REACTIVATED";

export interface BillingEventRow {
  readonly id: string;
  readonly storeId: string;
  readonly type: BillingEventTypeValue;
  readonly planCode: string | null;
  readonly chargeId: string | null;
  readonly amountCents: number | null;
  readonly interval: BillingIntervalValue | null;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

/** POST /billing/subscribe → 201 — top-level redirect to Shopify's decision screen. */
export interface SubscribeStartedResponse {
  readonly confirmationUrl: string;
  readonly chargeId: string;
}

/* ROI read-model (GET /analytics/roi) — methodology copy rides the data. */
export interface RoiReportResponse {
  readonly windowDays: number;
  readonly from: string;
  readonly to: string;
  readonly outcomes: {
    readonly attributedRevenueCents: number;
    readonly attributedOrdersCount: number;
    readonly measuredRecommendations: number;
  };
  readonly pipeline: {
    readonly openRecommendations: number;
    readonly openEstimatedRevenueCents: number;
    readonly highPriorityOpen: number;
  };
  readonly cost: { readonly micros: number; readonly calls: number };
  readonly roiMultiple: number | null;
  readonly acceptanceRatePct: number | null;
}

/* Platform admin read-models (GET /admin/* — key-gated, cross-tenant by design). */
export interface AdminDashboardRow {
  readonly merchants: { readonly total: number; readonly active: number; readonly uninstalled: number };
  readonly subscriptions: {
    readonly trialing: number;
    readonly active: number;
    readonly chargePending: number;
    readonly trialExpired: number;
    readonly cancelled: number;
    readonly suspended: number;
  };
  readonly modeledMrrCents: number;
  readonly modeledArrCents: number;
  readonly ai: { readonly runsLast7d: number; readonly costMicrosLast7d: number; readonly tokensLast7d: number };
  readonly system: {
    readonly jobsRunning: number;
    readonly jobsPending: number;
    readonly jobsFailed: number;
    readonly deadJobs: number;
  };
}

export interface FunnelStepRow {
  readonly kind: string;
  readonly stores: number;
  readonly conversionFromPreviousPct: number | null;
}

export interface AdminOverviewResponse {
  readonly dashboard: AdminDashboardRow;
  readonly funnel: readonly FunnelStepRow[];
}

export interface AdminMerchantRow {
  readonly storeId: string;
  readonly shopDomain: string;
  readonly name: string;
  readonly installedAt: string;
  readonly planCode: string | null;
  readonly subscriptionStatus: string | null;
  readonly trialEndsAt: string | null;
  readonly attributedRevenueCents: number;
  readonly aiCostMicrosLast30d: number;
  readonly lastActivityAt: string | null;
}

export interface AdminAiUsageRow {
  readonly storeId: string;
  readonly shopDomain: string;
  readonly calls: number;
  readonly tokens: number;
  readonly costMicros: number;
}

/* ── M6: Automation Center (workflows / campaigns / exports / support) ────
 * Every shape mirrors the M6 routers/workflows.router.ts, campaigns.router.ts,
 * exports.router.ts, support.router.ts and admin.router.ts responses EXACTLY
 * (definition contract: packages/automation/src/definition.ts). */

export type WorkflowNodeKindDto =
  | "TRIGGER"
  | "CONDITION"
  | "DELAY"
  | "SEND_EMAIL"
  | "SEND_SMS"
  | "TAG_CUSTOMER"
  | "CREATE_DISCOUNT";

export type WorkflowTriggerKindDto = "MANUAL" | "SCHEDULE" | "EVENT";
export type WorkflowStatusDto = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
export type WorkflowRunStatusDto = "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type WorkflowStepStatusDto = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

export interface WorkflowNodeDto {
  readonly id: string;
  readonly kind: WorkflowNodeKindDto;
  /** Shape depends on kind — see definition.ts schemas; kept open on the wire. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface WorkflowEdgeDto {
  readonly from: string;
  readonly to: string;
  readonly branch?: "YES" | "NO";
}

export interface WorkflowDefinitionDto {
  readonly nodes: readonly WorkflowNodeDto[];
  readonly edges: readonly WorkflowEdgeDto[];
}

export interface WorkflowRowDto {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: WorkflowStatusDto;
  readonly activeVersionId: string | null;
  readonly nextFireAt: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowVersionRowDto {
  readonly id: string;
  readonly workflowId: string;
  readonly version: number;
  readonly definition: WorkflowDefinitionDto;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
}

export interface WorkflowCreateResponse {
  readonly workflow: WorkflowRowDto;
  readonly version: WorkflowVersionRowDto;
}

export interface WorkflowDetailResponse {
  readonly workflow: WorkflowRowDto;
  readonly versions: readonly WorkflowVersionRowDto[];
  /** Latest ACTIVE version's definition — null while the workflow is a draft. */
  readonly activeDefinition: WorkflowDefinitionDto | null;
}

export interface WorkflowRunRowDto {
  readonly id: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly status: WorkflowRunStatusDto;
  readonly triggerKind: WorkflowTriggerKindDto;
  readonly triggerEventId: string;
  readonly subject: unknown;
  readonly resumeAt: string | null;
  readonly resumeFromNodeId: string | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export interface WorkflowRunStepRowDto {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeKind: WorkflowNodeKindDto;
  readonly status: WorkflowStepStatusDto;
  readonly attempts: number;
  readonly detail: unknown;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export interface WorkflowRunsResponse {
  readonly runs: readonly WorkflowRunRowDto[];
  readonly total: number;
}

export interface WorkflowRunDetailResponse {
  readonly run: WorkflowRunRowDto;
  readonly steps: readonly WorkflowRunStepRowDto[];
}

/* ── Campaigns ───────────────────────────────────────────────────────────── */

export type MessageChannelDto = "EMAIL" | "SMS";
export type CampaignStatusDto = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "CANCELLED" | "FAILED";
export type CampaignAudienceDto = "ALL_CUSTOMERS" | "MARKETING_OPT_IN" | "REPEAT_CUSTOMERS";
export type CampaignVariantDto = "A" | "B";

export interface CampaignTemplateRowDto {
  readonly id: string;
  readonly name: string;
  readonly channel: MessageChannelDto;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CampaignRowDto {
  readonly id: string;
  readonly name: string;
  readonly channel: MessageChannelDto;
  readonly audience: CampaignAudienceDto;
  readonly status: CampaignStatusDto;
  readonly variantA: unknown;
  readonly variantB: unknown;
  readonly splitBPercent: number;
  readonly winnerVariant: string | null;
  readonly scheduledAt: string | null;
  readonly sendingStartedAt: string | null;
  readonly sentAt: string | null;
  readonly cancelledAt: string | null;
  readonly recipientCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly lastError: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CampaignVariantStats {
  readonly variant: CampaignVariantDto;
  readonly sent: number;
  readonly uniqueOpens: number;
  readonly uniqueClicks: number;
  readonly openRate: number | null;
  readonly clickRate: number | null;
}

export interface CampaignStatsResponse {
  readonly recipients: {
    readonly pending: number;
    readonly sent: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly variants: readonly CampaignVariantStats[];
  readonly unsubscribes: number;
  readonly recentEvents: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly url: string | null;
    readonly createdAt: string;
  }>;
}

export interface SuppressionRowDto {
  readonly id: string;
  readonly destination: string;
  readonly reason: string;
  readonly channel: MessageChannelDto;
  readonly createdAt: string;
}

export interface SuppressionsResponse {
  readonly rows: readonly SuppressionRowDto[];
  readonly total: number;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

export type ExportKindDto = "AUDIT_LOGS" | "CUSTOMERS" | "ORDERS" | "PRODUCTS" | "RECOMMENDATIONS";
export type ExportFormatDto = "CSV" | "XLSX" | "PDF";
export type ExportStatusDto = "QUEUED" | "RUNNING" | "READY" | "FAILED";

export interface ExportRowDto {
  readonly id: string;
  readonly requestedByUserId: string | null;
  readonly kind: ExportKindDto;
  readonly format: ExportFormatDto;
  readonly status: ExportStatusDto;
  readonly params: unknown;
  readonly fileName: string | null;
  readonly rowCount: number | null;
  readonly sizeBytes: number | null;
  readonly error: string | null;
  readonly expiresAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export interface ExportsResponse {
  readonly rows: readonly ExportRowDto[];
  readonly total: number;
}

/* ── Support tickets (merchant side) ─────────────────────────────────────── */

export type SupportTicketCategoryDto = "BUG" | "BILLING" | "DATA" | "FEATURE" | "OTHER";
export type SupportTicketPriorityDto = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type SupportTicketStatusDto = "OPEN" | "AWAITING_MERCHANT" | "AWAITING_OPERATOR" | "RESOLVED" | "CLOSED";
export type TicketAuthorKindDto = "MERCHANT" | "OPERATOR";

export interface SupportTicketRowDto {
  readonly id: string;
  readonly openedByUserId: string | null;
  readonly subject: string;
  readonly category: SupportTicketCategoryDto;
  readonly priority: SupportTicketPriorityDto;
  readonly status: SupportTicketStatusDto;
  readonly messageCount: number;
  readonly lastMessageAt: string | null;
  readonly assignedOperator: string | null;
  readonly operatorAttention: boolean;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupportTicketMessageDto {
  readonly id: string;
  readonly authorKind: TicketAuthorKindDto;
  readonly authorUserId: string | null;
  readonly authorOperator: string | null;
  readonly authorEmail: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface SupportTicketsResponse {
  readonly rows: readonly SupportTicketRowDto[];
  readonly total: number;
}

export interface SupportTicketThreadResponse {
  readonly ticket: SupportTicketRowDto;
  readonly messages: readonly SupportTicketMessageDto[];
}

export interface SupportTicketReplyResponse {
  readonly ticket: SupportTicketRowDto;
  readonly message: SupportTicketMessageDto;
}

/* ── M6 platform-admin surface (key + step-up session, cross-tenant) ─────── */

export interface AdminSessionResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly operatorId: string;
}

export interface AdminTicketRowDto extends SupportTicketRowDto {
  readonly shopDomain: string;
  readonly storeName: string;
  readonly openerEmail: string | null;
}

export interface AdminTicketsResponse {
  readonly rows: readonly AdminTicketRowDto[];
  readonly total: number;
}

export interface AdminTicketThreadResponse {
  readonly ticket: AdminTicketRowDto;
  readonly messages: readonly SupportTicketMessageDto[];
}

export interface AdminTicketReplyResponse {
  readonly ticket: AdminTicketRowDto;
  readonly messageId: string;
}

export type AccessOverrideKindDto = "COMP_ACCESS" | "PAUSED_EXTENSION" | "CHARGE_FAILURE_GRACE";

export interface AccessOverrideRowDto {
  readonly id: string;
  readonly storeId: string;
  readonly kind: AccessOverrideKindDto;
  readonly accessUntil: string;
  readonly reason: string;
  readonly grantedBy: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly createdAt: string;
}

export interface AdminActionRowDto {
  readonly id: string;
  readonly storeId: string | null;
  readonly operatorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly payloadHash: string;
  readonly ip: string | null;
  readonly createdAt: string;
}

/** Subscription row returned by POST /admin/merchants/:id/trial-extension (mirror of billing SubscriptionRow). */
export interface AdminTrialExtensionResponse {
  readonly id: string;
  readonly storeId: string;
  readonly planId: string;
  readonly status: string;
  readonly shopifyChargeId: string | null;
  readonly billingInterval: string | null;
  readonly trialEndsAt: string | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly graceEndsAt: string | null;
  readonly cancelledAt: string | null;
}

/* ── M7: SOC-2-lite access review (admin read-only evidence) ─────────────── */

export interface AccessReviewStoreDto {
  readonly storeId: string;
  readonly name: string;
  readonly shopDomain: string;
  readonly status: string;
  readonly installedAt: string;
  readonly uninstalledAt: string | null;
}

export interface AccessReviewMemberDto {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly roleCode: string;
  readonly permissionCount: number;
  readonly memberSince: string;
  readonly lastLoginAt: string | null;
}

export interface AccessReviewOverrideDto {
  readonly id: string;
  readonly kind: AccessOverrideKindDto;
  readonly accessUntil: string;
  readonly grantedBy: string;
  readonly reason: string;
  readonly grantedAt: string;
}

export interface AccessReviewActionDto {
  readonly id: string;
  readonly operatorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly ip: string | null;
  readonly createdAt: string;
}

export interface AccessReviewResponseDto {
  readonly store: AccessReviewStoreDto;
  readonly members: readonly AccessReviewMemberDto[];
  readonly activeOverrides: readonly AccessReviewOverrideDto[];
  readonly recentActions: readonly AccessReviewActionDto[];
}

export interface OperatorSessionRowDto {
  readonly operatorId: string;
  readonly ip: string | null;
  readonly createdAt: string;
}

/* ── M8 Phase 3: AI copilot + enterprise reports ─────────────────────────── */

export type CopilotIntentDto =
  | "SALES_WHY_DOWN"
  | "RESTOCK_WHAT"
  | "VIP_CUSTOMERS"
  | "PRODUCTS_DYING"
  | "DISCOUNT_SUGGESTION"
  | "REVENUE_FORECAST"
  | "REVENUE_SUMMARY"
  | "CHURN_RISKS"
  | "BUSINESS_SUMMARY"
  | "GENERAL_OTHER";

export interface CopilotEvidenceTableDto {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface CopilotRecommendationRefDto {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

export interface CopilotEvidenceDto {
  readonly intent: CopilotIntentDto;
  readonly matchedPattern: string | null;
  readonly headline: string;
  readonly bullets: readonly string[];
  readonly tables: readonly CopilotEvidenceTableDto[];
  readonly recommendationRefs: readonly CopilotRecommendationRefDto[];
  readonly method: string;
  readonly confidence: number;
  readonly currency: string;
  readonly windowLabel: string;
}

export interface CopilotAskResponseDto {
  readonly conversationId: string;
  readonly messageId: string;
  readonly intent: CopilotIntentDto;
  readonly answer: string;
  readonly modelEnhanced: boolean;
  readonly evidence: CopilotEvidenceDto;
}

export interface CopilotConversationListItemDto {
  readonly id: string;
  readonly title: string;
  readonly lastMessageAt: string;
  readonly createdAt: string;
}

export interface CopilotAssistantPayloadDto {
  readonly headline: string;
  readonly lead: string;
  readonly bullets: readonly string[];
  readonly tables: readonly CopilotEvidenceTableDto[];
  readonly recommendationRefs: readonly CopilotRecommendationRefDto[];
  readonly method: string;
  readonly confidence: number;
  readonly modelEnhanced: boolean;
  readonly windowLabel: string;
}

export interface CopilotMessageDto {
  readonly id: string;
  readonly role: "MERCHANT" | "ASSISTANT";
  readonly intent: string | null;
  readonly content: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface CopilotConversationDetailDto {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly CopilotMessageDto[];
}

export type ReportKindDto = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY";
export type ReportStatusDto = "BUILDING" | "READY" | "FAILED";

export interface ReportListItemDto {
  readonly id: string;
  readonly kind: ReportKindDto;
  readonly status: ReportStatusDto;
  readonly periodLabel: string;
  readonly headline: string | null;
  readonly executiveSummary: string | null;
  readonly pdfSizeBytes: number | null;
  readonly lastEmailedOn: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly errorMessage: string | null;
}

export interface ReportKpiDto {
  readonly label: string;
  readonly display: string;
  readonly deltaPct?: number | null;
}

export interface ReportTableDto {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface ReportForecastDto {
  readonly method: string;
  readonly horizonDays: number;
  readonly expectedCents: number;
  readonly lowCents: number;
  readonly highCents: number;
  readonly stockoutRisks: number;
  readonly churnRisks: number;
}

export interface ReportActionsDto {
  readonly createdInPeriod: number;
  readonly executedInPeriod: number;
  readonly openPendingAtEnd: number;
}

export interface ReportSectionsDto {
  readonly storeName: string;
  readonly currency: string;
  readonly kind: ReportKindDto;
  readonly periodLabel: string;
  readonly period: { readonly startIso: string; readonly endIsoExclusive: string };
  readonly generatedAt: string;
  readonly headline: string;
  readonly kpis: readonly ReportKpiDto[];
  readonly highlights: readonly string[];
  readonly performance: ReportTableDto;
  readonly topProducts: ReportTableDto | null;
  readonly forecast: ReportForecastDto | null;
  readonly actions: ReportActionsDto;
}

export interface ReportDetailDto extends ReportListItemDto {
  readonly sections: ReportSectionsDto | null;
}

export interface ReportGenerateResponseDto {
  readonly reportId: string;
  readonly kind: ReportKindDto;
  readonly periodLabel: string;
  readonly status: ReportStatusDto;
  readonly errorMessage: string | null;
}

export interface ReportEmailOutcomeDto {
  readonly sent: boolean;
  readonly reason: string | null;
}

/** Store settings report preferences (nested-merge PATCH shape). */
export interface ReportPreferencesDto {
  readonly kinds?: Partial<Record<ReportKindDto, boolean>>;
  readonly emailDelivery?: boolean;
  readonly recipientEmail?: string | null;
}
