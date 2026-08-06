import type {
  AnalyticsSummaryResponse,
  AuditLogRow,
  CustomerDetailResponse,
  CustomerRow,
  GlobalSearchResponse,
  InventoryLevelRow,
  NotificationRow,
  OrderDetailResponse,
  OrderRow,
  ProductDetailRow,
  ProductRow,
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
      monthlyPriceCents: 4900,
      yearlyPriceCents: 49000,
      trialDays: 3,
      entitlements: {},
    },
  };
}

export function syncStatusResponse(overrides: Partial<SyncStatusResponse["modules"][number]> = {}): SyncStatusResponse {
  const modules = ["PRODUCTS", "CUSTOMERS", "ORDERS", "INVENTORY", "COLLECTIONS", "DISCOUNTS", "METAFIELDS"] as const;
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
    body: "All 7 modules synced successfully.",
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
