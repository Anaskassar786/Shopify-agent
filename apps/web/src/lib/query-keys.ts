/** Central query keys — invalidation and hooks can never typo-drift. */
export const QK = {
  store: ["store"] as const,
  dashboard: (days: number) => ["dashboard", days] as const,
  analyticsSummary: (days: number) => ["analytics", "summary", days] as const,
  topProducts: (days: number) => ["analytics", "top-products", days] as const,
  topCustomers: (days: number) => ["analytics", "top-customers", days] as const,
  syncStatus: ["sync", "status"] as const,
  syncHistory: (page: number) => ["sync", "history", page] as const,
  products: (page: number, q: string) => ["catalog", "products", page, q] as const,
  product: (id: string) => ["catalog", "product", id] as const,
  productVariants: (id: string) => ["catalog", "product-variants", id] as const,
  customers: (page: number, q: string) => ["catalog", "customers", page, q] as const,
  customer: (id: string) => ["catalog", "customer", id] as const,
  orders: (page: number, status: string) => ["catalog", "orders", page, status] as const,
  order: (id: string) => ["catalog", "order", id] as const,
  inventory: (page: number, belowOnly: boolean) => ["catalog", "inventory", page, belowOnly] as const,
  notifications: (filter: string) => ["notifications", filter] as const,
  auditLogs: (page: number, action: string, result: string) => ["audit-logs", page, action, result] as const,
  subscription: ["subscription"] as const,
  search: (q: string) => ["search", q] as const,
};

/** M4 AI-plane keys (recommendations/ai/automation roots mirror the realtime invalidation map). */
export const AI_QK = {
  recommendations: (page: number, status: string, priority: string, type: string) =>
    ["recommendations", page, status, priority, type] as const,
  recommendation: (id: string) => ["recommendations", "detail", id] as const,
  aiOverview: ["ai", "overview"] as const,
  automationOverview: ["automation", "overview"] as const,
};
