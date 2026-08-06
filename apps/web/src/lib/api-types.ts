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
