import type {
  AdminAiUsageRow,
  AdminMerchantRow,
  AdminOverviewResponse,
  AiOverviewResponse,
  AnalyticsSummaryResponse,
  AuditLogRow,
  BillingEventRow,
  BillingOverviewResponse,
  AutomationOverviewResponse,
  CustomerDetailResponse,
  CustomerRow,
  GlobalSearchResponse,
  InventoryLevelRow,
  NotificationRow,
  OrderDetailResponse,
  OrderRow,
  PlanRow,
  PlansCatalogResponse,
  ProductDetailRow,
  ProductRow,
  RecommendationDetail,
  RecommendationRow,
  RoiReportResponse,
  StoreResponse,
  SubscriptionResponse,
  SyncHistoryRow,
  SyncStatusResponse,
  TopCustomerRow,
  TopProductRow,
  VariantRow,
} from "../lib/api-types";

/** Deterministic fixtures mirroring the v1 wire shapes exactly (M1–M3). */

export const STORE_ID = "22222222-2222-4222-8222-222222222222";
export const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";
export const CUSTOMER_ID = "44444444-4444-4444-8444-444444444444";
export const ORDER_ID = "55555555-5555-4555-8555-555555555555";

const DAY_MS = 24 * 60 * 60 * 1000;

export function storeResponse(overrides: {
  readonly onboardingCompletedAt?: string | null;
  readonly subscription?: boolean;
} = {}): StoreResponse {
  return {
    store: {
      id: STORE_ID,
      shopDomain: "moradabad-gems.myshopify.com",
      name: "Moradabad Gems",
      email: "owner@moradabad-gems.in",
      currency: "USD",
      timezone: "Asia/Calcutta",
      status: "ACTIVE",
      installedAt: "2026-07-20T10:00:00.000Z",
    },
    settings: {
      id: "settings-1",
      branding: { primaryColor: "#6d6af8" },
      aiPreferences: { autonomyMode: "MANUAL" },
      automationPreferences: {},
      featureOverrides: {},
      reportPreferences: {},
      onboardingCompletedAt:
        overrides.onboardingCompletedAt === undefined ? "2026-07-21T09:00:00.000Z" : overrides.onboardingCompletedAt,
    },
    subscription: overrides.subscription === false ? null : {
      id: "sub-1",
      status: "TRIALING",
      trialEndsAt: "2026-08-08T10:00:00.000Z",
      currentPeriodStart: "2026-08-05T10:00:00.000Z",
      currentPeriodEnd: "2026-09-04T10:00:00.000Z",
      planId: "plan-growth",
    },
    supportEmail: "support@profittool.ai",
  };
}

export function subscriptionResponse(): SubscriptionResponse {
  // Computed off the wall clock so the trial countdown is 3 days in ANY environment.
  const trialEndsAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  return {
    subscription: {
      id: "sub-1",
      status: "TRIALING",
      trialEndsAt,
      currentPeriodStart: "2026-08-05T10:00:00.000Z",
      currentPeriodEnd: "2026-09-04T10:00:00.000Z",
      planId: "plan-growth",
    },
    plan: {
      id: "plan-growth",
      code: "GROWTH",
      name: "Growth",
      description: "For scaling stores",
      monthlyPriceCents: 7900,
      yearlyPriceCents: 79000,
      trialDays: 3,
      isActive: true,
      entitlements: {
        capabilities: ["analytics", "ai-decisions", "automation"],
        quotas: { aiCalls: 2000, emails: 10_000, sms: 0, automationRuns: 1000, seats: 5, stores: 1 },
      },
    },
  };
}

export function syncStatusResponse(overrides: Partial<SyncStatusResponse["modules"][number]> = {}): SyncStatusResponse {
  const modules = ["PRODUCTS", "CUSTOMERS", "ORDERS", "INVENTORY", "COLLECTIONS", "DISCOUNTS", "METAFIELDS", "CHECKOUTS"] as const; // M4: 8 modules
  return {
    storeId: STORE_ID,
    modules: modules.map((module) => ({
      module,
      status: "COMPLETED" as const,
      mode: "FULL",
      startedAt: "2026-08-05T08:00:00.000Z",
      finishedAt: "2026-08-05T08:04:00.000Z",
      stats: { processed: 120, created: 5, updated: 115, failed: 0 },
      errorMessage: null,
      retryCount: 0,
      ...overrides,
    })),
  };
}

export function summaryResponse(): AnalyticsSummaryResponse {
  const series = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    ordersCount: 3 + (i % 5),
    itemsSold: 6 + (i % 7),
    newCustomers: 1 + (i % 3),
    netSalesCents: 4000 + i * 100,
    grossSalesCents: 4500 + i * 100,
    refundsCents: i % 4 === 0 ? 200 : 0,
  }));
  return {
    range: { days: 30, since: "2026-07-06" },
    totals: {
      ordersCount: 120,
      cancelledOrders: 2,
      itemsSold: 260,
      newCustomers: 45,
      returningCustomers: 30,
      grossSalesCents: 140000,
      discountsCents: 5100,
      refundsCents: 5000,
      netSalesCents: 129900,
      taxesCents: 6400,
      shippingCents: 3200,
      aovCents: 1082,
      currency: "USD",
    },
    series,
  };
}

export const TOP_PRODUCTS: readonly TopProductRow[] = [
  { productId: PRODUCT_ID, title: "Alpha Runner", unitsSold: 41, revenueCents: 82000 },
  { productId: "p2", title: "Beta Glider", unitsSold: 22, revenueCents: 31900 },
];

export const TOP_CUSTOMERS: readonly TopCustomerRow[] = [
  { customerId: CUSTOMER_ID, email: "sam@example.com", firstName: "Sam", lastName: "Iyer", ordersCount: 7, totalSpentCents: 45600 },
  { customerId: "c2", email: "vip@example.com", firstName: null, lastName: null, ordersCount: 3, totalSpentCents: 22100 },
];

export const PRODUCTS: readonly ProductRow[] = [
  {
    id: PRODUCT_ID,
    title: "Alpha Runner",
    status: "ACTIVE",
    vendor: "Acme",
    productType: "Shoes",
    tags: ["running", "new"],
    handle: "alpha-runner",
    updatedAt: "2026-08-01T10:00:00.000Z",
    shopifyUpdatedAt: "2026-08-04T10:00:00.000Z",
  },
  {
    id: "p2",
    title: "Beta Glider",
    status: "DRAFT",
    vendor: null,
    productType: null,
    tags: [],
    handle: "beta-glider",
    updatedAt: "2026-07-30T10:00:00.000Z",
    shopifyUpdatedAt: null,
  },
];

export function productDetail(): ProductDetailRow {
  return {
    ...PRODUCTS[0]!,
    shopifyProductId: "gid://shopify/Product/7643",
    bodyHtml: "<p>Featherlight <b>racing</b> shoe.</p>",
    publishedAt: "2026-06-01T10:00:00.000Z",
    shopifyCreatedAt: "2026-05-28T10:00:00.000Z",
    createdAt: "2026-07-20T10:05:00.000Z",
  };
}

export const VARIANTS: readonly VariantRow[] = [
  { id: "v1", title: "42 / Black", sku: "ALP-42-BLK", price: "199.00", compareAtPrice: "229.00", inventoryItemId: "ii-1", position: 1, barcode: null },
  { id: "v2", title: "43 / Black", sku: "ALP-43-BLK", price: "199.00", compareAtPrice: null, inventoryItemId: "ii-2", position: 2, barcode: "8901234" },
];

export const CUSTOMERS: readonly CustomerRow[] = [
  {
    id: CUSTOMER_ID,
    email: "sam@example.com",
    firstName: "Sam",
    lastName: "Iyer",
    phone: null,
    ordersCount: 7,
    totalSpent: "456.00",
    acceptsMarketing: true,
    tags: ["vip"],
  },
  {
    id: "c2",
    email: null,
    firstName: "Guest",
    lastName: null,
    phone: "+91-90000-00000",
    ordersCount: 1,
    totalSpent: "49.00",
    acceptsMarketing: false,
    tags: [],
  },
];

export function customerDetail(): CustomerDetailResponse {
  return {
    customer: CUSTOMERS[0]!,
    metrics: {
      ordersCount: 7,
      totalSpentCents: 45600,
      aovCents: 6514,
      firstOrderAt: "2026-04-02T10:00:00.000Z",
      lastOrderAt: "2026-08-03T10:00:00.000Z",
    },
    recentOrders: [ORDERS[0]!],
  };
}

export const ORDERS: readonly OrderRow[] = [
  {
    id: ORDER_ID,
    name: "#1042",
    orderNumber: 1042,
    email: "sam@example.com",
    financialStatus: "paid",
    fulfillmentStatus: "fulfilled",
    currency: "USD",
    totalPrice: "248.00",
    processedAt: "2026-08-03T10:00:00.000Z",
    createdAt: "2026-08-03T10:00:01.000Z",
  },
  {
    id: "o2",
    name: "#1043",
    orderNumber: 1043,
    email: null,
    financialStatus: "pending",
    fulfillmentStatus: null,
    currency: "USD",
    totalPrice: "49.00",
    processedAt: null,
    createdAt: "2026-08-04T11:00:00.000Z",
  },
];

export function orderDetail(): OrderDetailResponse {
  return {
    order: ORDERS[0]!,
    lineItems: [
      { id: "li-1", title: "Alpha Runner — 42 / Black", quantity: 1, price: "199.00", sku: "ALP-42-BLK" },
      { id: "li-2", title: "Gift wrap", quantity: 1, price: "49.00", sku: null },
    ],
  };
}

export const INVENTORY_LEVELS: readonly InventoryLevelRow[] = [
  { id: "il-1", available: -1, locationName: "Warehouse A", sku: "ALP-42-BLK", variantTitle: "42 / Black", productTitle: "Alpha Runner", updatedAt: "2026-08-05T06:00:00.000Z" },
  { id: "il-2", available: 3, locationName: "Warehouse A", sku: "BET-40-WHT", variantTitle: "40 / White", productTitle: "Beta Glider", updatedAt: "2026-08-05T06:00:00.000Z" },
  { id: "il-3", available: 14, locationName: "Storefront", sku: "ALP-43-BLK", variantTitle: "43 / Black", productTitle: "Alpha Runner", updatedAt: "2026-08-05T06:00:00.000Z" },
];

export const NOTIFICATIONS: readonly NotificationRow[] = [
  {
    id: "n-1",
    storeId: STORE_ID,
    userId: null,
    category: "SYSTEM",
    title: "Data sync complete",
    body: "All 8 modules synced successfully.",
    actionUrl: "/dashboard",
    readAt: null,
    createdAt: "2026-08-05T08:05:00.000Z",
  },
  {
    id: "n-2",
    storeId: STORE_ID,
    userId: null,
    category: "SECURITY",
    title: "New sign-in",
    body: "A new device signed in to your workspace.",
    actionUrl: null,
    readAt: "2026-08-05T07:00:00.000Z",
    createdAt: "2026-08-05T06:55:00.000Z",
  },
];

export const AUDIT_ROWS: readonly AuditLogRow[] = [
  {
    id: "a-1",
    action: "store.settings.updated",
    entityType: "store",
    entityId: STORE_ID,
    result: "SUCCESS",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    userId: "11111111-1111-4111-8111-111111111111",
    metadata: {},
    createdAt: "2026-08-05T07:30:00.000Z",
  },
  {
    id: "a-2",
    action: "billing.subscription.trial_started",
    entityType: "subscription",
    entityId: "sub-1",
    result: "SUCCESS",
    ip: null,
    userAgent: null,
    userId: null,
    metadata: {},
    createdAt: "2026-08-02T10:00:00.000Z",
  },
];

export const SYNC_HISTORY: readonly SyncHistoryRow[] = [
  {
    id: "sh-1",
    storeId: STORE_ID,
    module: "ORDERS",
    mode: "FULL",
    status: "COMPLETED",
    stats: { processed: 88, created: 2, updated: 86, failed: 0 },
    errorMessage: null,
    retryCount: 0,
    startedAt: "2026-08-05T08:00:00.000Z",
    finishedAt: "2026-08-05T08:01:30.000Z",
    createdAt: "2026-08-05T08:00:00.000Z",
  },
];

export function searchResponse(): GlobalSearchResponse {
  return {
    query: "alp",
    groups: {
      products: { permitted: true, total: 1, items: [{ id: PRODUCT_ID, title: "Alpha Runner", status: "ACTIVE", handle: "alpha-runner" }] },
      customers: { permitted: true, total: 0, items: [] },
      orders: { permitted: false, total: 0, items: [] },
    },
  };
}

/* ── AI revenue loop fixtures (M4 wire shapes) ───────────────────────────── */

export const RECOMMENDATION_ID = "66666666-6666-4666-8666-666666666666";

export function recommendationRow(overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    id: RECOMMENDATION_ID,
    storeId: STORE_ID,
    type: "RECOVER_ABANDONED_CART",
    agentId: "REVENUE_RECOVERY",
    ruleId: "cart.abandoned-recovery",
    title: "Recover Mia's abandoned cart",
    description: "A shopper left $48.00 behind 9 hours ago. A recovery email with a small discount converts best in the first 24 hours.",
    reasoning: [
      "Checkout abandoned 9 hours ago with a reachable email",
      "Carts under 24h old convert at 2.4% in the baseline rule model",
      "The cart value clears your minimum for automation",
    ],
    priority: "HIGH",
    confidence: 85,
    riskLevel: "LOW",
    estimatedRevenueCents: 1152,
    estimatedCostCents: 960,
    subjects: { checkoutTokens: ["tok-1"] },
    actionType: "SEND_RECOVERY_EMAIL",
    actionParams: { template: "RECOVERY", checkoutToken: "tok-1", discountPercent: 10 },
    status: "PENDING_APPROVAL",
    stateVersion: 1,
    decidedByUserId: null,
    decidedAt: null,
    decisionReason: null,
    expiresAt: "2026-08-08T10:00:00.000Z",
    createdAt: "2026-08-05T10:00:00.000Z",
    ...overrides,
  };
}

export const RECOMMENDATIONS: readonly RecommendationRow[] = [
  recommendationRow(),
  recommendationRow({
    id: "66666666-6666-4666-8666-666666666667",
    type: "RESTOCK",
    agentId: "INVENTORY",
    title: "Restock Alpha Runner before the weekend",
    priority: "MEDIUM",
    confidence: 74,
    estimatedRevenueCents: 3840,
    estimatedCostCents: 0,
    actionType: "ADVISORY",
    subjects: { productIds: ["p1"] },
  }),
  recommendationRow({
    id: "66666666-6666-4666-8666-666666666668",
    type: "WINBACK_INACTIVE",
    agentId: "CUSTOMER_INTELLIGENCE",
    title: "Win back 14 quiet customers with one email",
    priority: "CRITICAL",
    confidence: 91,
    estimatedRevenueCents: 5210,
    estimatedCostCents: 520,
    status: "EXECUTED",
  }),
];

export function recommendationDetail(overrides: Partial<RecommendationDetail> = {}): RecommendationDetail {
  return {
    ...recommendationRow(),
    evidence: {
      computedAt: "2026-08-05T10:00:00.000Z",
      storeHealthScore: 71,
      facts: ["Cart total $48.00", "9 hours since abandonment", "Email on file: yes"],
      rule: { id: "cart.abandoned-recovery", version: 1 },
      estimates: {
        revenueCents: 1152,
        costCents: 960,
        roiMultiple: 1.2,
        expectationBasis: "deterministic rule catalog constants",
      },
      calibration: {
        modelConfidence: 88,
        finalConfidence: 85,
        tier: "HIGH",
        modelPriority: "HIGH",
        finalPriority: "HIGH",
        modelRisk: "LOW",
        finalRisk: "LOW",
      },
      contextDigest: {
        netCents: 612_000,
        trendPct: 4.2,
        ordersCount: 120,
        customersTotal: 86,
        abandonedCount: 3,
        refundsRatePct: 1.1,
      },
      model: { provider: "gemini", promptId: "agent.revenue_recovery", promptVersion: "v1" },
    },
    events: [
      {
        id: "ev-1",
        event: "CREATED",
        actorType: "AI",
        actorUserId: null,
        fromStatus: null,
        toStatus: "PENDING_APPROVAL",
        details: { ruleId: "cart.abandoned-recovery", confidence: 85 },
        createdAt: "2026-08-05T10:00:00.000Z",
      },
    ],
    executions: [],
    ...overrides,
  };
}

export function aiOverviewResponse(overrides: Partial<AiOverviewResponse> = {}): AiOverviewResponse {
  return {
    engine: {
      lastRunAt: "2026-08-05T10:00:00.000Z",
      lastRunStatus: "COMPLETED",
      lastRunTrigger: "SCHEDULED",
      runsLast7d: 12,
      costMicrosLast7d: 2_240,
      tokensLast7d: 41_300,
    },
    health: {
      score: 71,
      computedAt: "2026-08-05T10:00:05.000Z",
      components: {
        components: [
          { key: "revenueTrend", label: "Revenue trend", score: 78, weight: 25, reason: "Sales are up 4% vs the previous window" },
          { key: "checkoutRecovery", label: "Checkout recovery", score: 55, weight: 15, reason: "3 abandoned carts are still open" },
        ],
      },
    },
    open: { pendingApproval: 2, approved: 1, executing: 0, highPriorityOpen: 2 },
    outcomes: { acceptanceRatePct: 64, attributedRevenueCents: 9_600, attributedOrders: 4 },
    recentEvents: [
      {
        id: "ev-9",
        recommendationId: RECOMMENDATION_ID,
        event: "CREATED",
        actorType: "AI",
        title: "Recover Mia's abandoned cart",
        type: "RECOVER_ABANDONED_CART",
        createdAt: "2026-08-05T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

export function aiOverviewZeroState(): AiOverviewResponse {
  return {
    engine: {
      lastRunAt: null,
      lastRunStatus: null,
      lastRunTrigger: null,
      runsLast7d: 0,
      costMicrosLast7d: 0,
      tokensLast7d: 0,
    },
    health: { score: null, computedAt: null, components: null },
    open: { pendingApproval: 0, approved: 0, executing: 0, highPriorityOpen: 0 },
    outcomes: { acceptanceRatePct: null, attributedRevenueCents: 0, attributedOrders: 0 },
    recentEvents: [],
  };
}

export function automationOverviewResponse(overrides: Partial<AutomationOverviewResponse> = {}): AutomationOverviewResponse {
  return {
    policy: {
      mode: "MANUAL",
      abandonedCartEnabled: true,
      abandonedCartDelayHours: 6,
      abandonedCartMinValueCents: 0,
      abandonedCartDiscountPercent: 10,
      maxAutoDiscountPercent: 15,
      maxAutoApproveEstimatedRevenueCents: 50_000,
    },
    executions: [
      {
        id: "ex-1",
        recommendationId: "66666666-6666-4666-8666-666666666668",
        recommendationTitle: "Win back 14 quiet customers with one email",
        type: "WINBACK_INACTIVE",
        actionType: "SEND_RECOVERY_EMAIL",
        status: "SUCCEEDED",
        errorMessage: null,
        attempts: 1,
        preview: { discountCode: "PT-WINBACK14", recipients: 14 },
        createdAt: "2026-08-04T09:00:00.000Z",
        finishedAt: "2026-08-04T09:00:08.000Z",
      },
    ],
    outcomes: { attributedRevenueCents: 9_600, attributedOrders: 4, measuredCount: 1 },
    ...overrides,
  };
}

/* ── M5 billing / growth fixtures ────────────────────────────────────────── */

export function planFixture(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: "plan-growth",
    code: "GROWTH",
    name: "Growth",
    description: "For scaling stores",
    monthlyPriceCents: 7900,
    yearlyPriceCents: 79000,
    trialDays: 3,
    isActive: true,
    entitlements: {
      capabilities: ["analytics", "ai-decisions", "automation"],
      quotas: { aiCalls: 2000, emails: 10_000, sms: 0, automationRuns: 1000, seats: 5, stores: 1 },
    },
    ...overrides,
  };
}

export function plansCatalogFixture(currentPlanId: string | null = "plan-starter"): PlansCatalogResponse {
  return {
    currentPlanId,
    plans: [
      planFixture({
        id: "plan-starter",
        code: "STARTER",
        name: "Starter",
        description: "For new stores finding their rhythm",
        monthlyPriceCents: 2900,
        yearlyPriceCents: 29000,
        entitlements: {
          capabilities: ["analytics", "ai-decisions"],
          quotas: { aiCalls: 100, emails: 500, sms: 0, automationRuns: 20, seats: 2, stores: 1 },
        },
      }),
      planFixture(),
      planFixture({
        id: "plan-professional",
        code: "PROFESSIONAL",
        name: "Professional",
        description: "For stores scaling decision volume",
        monthlyPriceCents: 24900,
        yearlyPriceCents: 249000,
        entitlements: {
          capabilities: ["analytics", "ai-decisions", "automation", "priority-support"],
          quotas: { aiCalls: 8000, emails: 50_000, sms: 0, automationRuns: 5000, seats: 10, stores: 2 },
        },
      }),
      planFixture({
        id: "plan-enterprise",
        code: "ENTERPRISE",
        name: "Enterprise",
        description: "For fleets and agencies",
        monthlyPriceCents: 99900,
        yearlyPriceCents: 999000,
        trialDays: 14,
        entitlements: {
          capabilities: ["analytics", "ai-decisions", "automation", "priority-support", "sla"],
          quotas: { aiCalls: 50_000, emails: 250_000, sms: 0, automationRuns: 25_000, seats: 50, stores: 10 },
        },
      }),
    ],
  };
}

export function billingOverviewFixture(
  overrides: {
    readonly status?: string;
    readonly access?: BillingOverviewResponse["access"];
    readonly withPlan?: boolean;
  } = {},
): BillingOverviewResponse {
  const withPlan = overrides.withPlan ?? true;
  if (!withPlan) {
    return {
      subscription: null,
      plan: null,
      usage: {
        window: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-06T00:00:00.000Z" },
        meters: [
          { meter: "AI_CALLS", used: 0, limit: 0, percentUsed: null },
          { meter: "EMAILS_SENT", used: 0, limit: 0, percentUsed: null },
          { meter: "SMS_SENT", used: 0, limit: 0, percentUsed: null },
          { meter: "AUTOMATION_RUNS", used: 0, limit: 0, percentUsed: null },
        ],
        entitlements: null,
        status: null,
      },
      access: { revenueActionsAllowed: false, blockedReason: "Start your free trial to unlock revenue actions" },
    };
  }
  const status = overrides.status ?? "TRIALING";
  return {
    subscription: {
      id: "sub-1",
      status,
      trialEndsAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
      currentPeriodStart: null,
      currentPeriodEnd: "2026-09-05T10:00:00.000Z",
      planId: "plan-growth",
      shopifyChargeId: null,
      billingInterval: null,
      graceEndsAt: null,
      cancelledAt: null,
    },
    plan: planFixture(),
    usage: {
      window: { from: "2026-08-05T10:00:00.000Z", to: "2026-09-05T10:00:00.000Z" },
      meters: [
        { meter: "AI_CALLS", used: 148, limit: 2000, percentUsed: 7 },
        { meter: "EMAILS_SENT", used: 812, limit: 10_000, percentUsed: 8 },
        { meter: "SMS_SENT", used: 0, limit: 0, percentUsed: null },
        { meter: "AUTOMATION_RUNS", used: 96, limit: 1000, percentUsed: 10 },
      ],
      entitlements: planFixture().entitlements,
      status,
    },
    access:
      overrides.access ??
      (status === "TRIALING"
        ? { revenueActionsAllowed: true, blockedReason: null }
        : { revenueActionsAllowed: false, blockedReason: "Your trial has ended. Choose a plan to continue." }),
  };
}

export const BILLING_HISTORY: readonly BillingEventRow[] = [
  {
    id: "billevt-3",
    storeId: STORE_ID,
    type: "CHARGE_ACCEPTED",
    planCode: "GROWTH",
    chargeId: "900101",
    amountCents: 7900,
    interval: "MONTHLY",
    fromStatus: "CHARGE_PENDING",
    toStatus: "ACTIVE",
    metadata: { source: "callback" },
    createdAt: "2026-08-05T11:20:00.000Z",
  },
  {
    id: "billevt-2",
    storeId: STORE_ID,
    type: "CHARGE_CREATED",
    planCode: "GROWTH",
    chargeId: "900101",
    amountCents: 7900,
    interval: "MONTHLY",
    fromStatus: "TRIALING",
    toStatus: "CHARGE_PENDING",
    metadata: {},
    createdAt: "2026-08-05T11:05:00.000Z",
  },
  {
    id: "billevt-1",
    storeId: STORE_ID,
    type: "TRIAL_STARTED",
    planCode: "GROWTH",
    chargeId: null,
    amountCents: null,
    interval: null,
    fromStatus: null,
    toStatus: "TRIALING",
    metadata: {},
    createdAt: "2026-08-03T09:00:00.000Z",
  },
];

export function roiReportFixture(overrides: Partial<RoiReportResponse> = {}): RoiReportResponse {
  return {
    windowDays: 30,
    from: "2026-07-07T00:00:00.000Z",
    to: "2026-08-06T00:00:00.000Z",
    outcomes: {
      attributedRevenueCents: 184_500,
      attributedOrdersCount: 37,
      measuredRecommendations: 9,
    },
    pipeline: {
      openRecommendations: 6,
      openEstimatedRevenueCents: 420_000,
      highPriorityOpen: 2,
    },
    cost: { micros: 3_250_000, calls: 214 },
    roiMultiple: 56.8,
    acceptanceRatePct: 64.3,
    ...overrides,
  };
}

/* ── M5 admin fixtures ───────────────────────────────────────────────────── */

export function adminOverviewFixture(): AdminOverviewResponse {
  return {
    dashboard: {
      merchants: { total: 41, active: 36, uninstalled: 5 },
      subscriptions: { trialing: 12, active: 18, chargePending: 2, trialExpired: 3, cancelled: 4, suspended: 1 },
      modeledMrrCents: 1_820_000,
      modeledArrCents: 21_840_000,
      ai: { runsLast7d: 96, costMicrosLast7d: 84_000_000, tokensLast7d: 12_400_000 },
      system: { jobsRunning: 3, jobsPending: 7, jobsFailed: 1, deadJobs: 0 },
    },
    funnel: [
      { kind: "STORE_CONNECTED", stores: 41, conversionFromPreviousPct: null },
      { kind: "FIRST_SYNC_COMPLETED", stores: 38, conversionFromPreviousPct: 92.7 },
      { kind: "FIRST_AI_RUN_COMPLETED", stores: 30, conversionFromPreviousPct: 78.9 },
      { kind: "FIRST_AI_INSIGHT_VIEWED", stores: 27, conversionFromPreviousPct: 90 },
      { kind: "FIRST_RECOMMENDATION_APPROVED", stores: 19, conversionFromPreviousPct: 70.4 },
      { kind: "FIRST_AUTOMATION_ENABLED", stores: 11, conversionFromPreviousPct: 57.9 },
      { kind: "PAID_SUBSCRIPTION_STARTED", stores: 18, conversionFromPreviousPct: 163.6 },
    ],
  };
}

export const ADMIN_MERCHANTS: readonly AdminMerchantRow[] = [
  {
    storeId: STORE_ID,
    shopDomain: "moradabad-gems.myshopify.com",
    name: "Moradabad Gems",
    installedAt: "2026-07-20T10:00:00.000Z",
    planCode: "GROWTH",
    subscriptionStatus: "ACTIVE",
    trialEndsAt: null,
    attributedRevenueCents: 184_500,
    aiCostMicrosLast30d: 3_250_000,
    lastActivityAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  },
  {
    storeId: "77777777-7777-4777-8777-777777777777",
    shopDomain: "brass-city-lights.myshopify.com",
    name: "Brass City Lights",
    installedAt: "2026-08-04T08:30:00.000Z",
    planCode: "STARTER",
    subscriptionStatus: "TRIALING",
    trialEndsAt: new Date(Date.now() + DAY_MS).toISOString(),
    attributedRevenueCents: 0,
    aiCostMicrosLast30d: 410_000,
    lastActivityAt: new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
  },
];

export const ADMIN_AI_USAGE: readonly AdminAiUsageRow[] = [
  { storeId: STORE_ID, shopDomain: "moradabad-gems.myshopify.com", calls: 214, tokens: 2_180_000, costMicros: 3_250_000 },
  { storeId: "77777777-7777-4777-8777-777777777777", shopDomain: "brass-city-lights.myshopify.com", calls: 26, tokens: 310_000, costMicros: 410_000 },
];
