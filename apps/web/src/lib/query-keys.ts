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

/** M5 billing/growth-plane keys. */
export const BILLING_QK = {
  overview: ["billing", "overview"] as const,
  plans: ["billing", "plans"] as const,
  history: ["billing", "history"] as const,
  roi: (windowDays: number) => ["billing", "roi", windowDays] as const,
};

/** M5 platform-admin keys (separate auth: key-gated, outside the merchant session). */
export const ADMIN_QK = {
  overview: ["admin", "overview"] as const,
  merchants: (page: number) => ["admin", "merchants", page] as const,
  aiUsage: ["admin", "ai-usage"] as const,
  /** M6 write surface + support inbox. */
  tickets: (page: number, attention: boolean, status: string) =>
    ["admin", "tickets", page, attention, status] as const,
  ticket: (id: string) => ["admin", "tickets", "detail", id] as const,
  actions: (page: number) => ["admin", "actions", page] as const,
  overrides: (storeId: string) => ["admin", "overrides", storeId] as const,
  /** M7 SOC-2-lite access review. */
  review: (storeId: string) => ["admin", "access-review", storeId] as const,
  reviewSessions: ["admin", "access-review", "sessions"] as const,
  /** Launch readiness: ops control plane (ADR 37). */
  opsFlags: ["admin", "ops", "flags"] as const,
  opsJobs: ["admin", "ops", "jobs"] as const,
  featureFlags: (storeId: string) => ["admin", "ops", "feature-flags", storeId] as const,
};

/** M6 Automation Center keys (tenant-scoped merchant app). */
export const M6_QK = {
  workflows: ["workflows"] as const,
  workflow: (id: string) => ["workflows", id] as const,
  workflowRuns: (id: string, page: number) => ["workflows", id, "runs", page] as const,
  runSteps: (workflowId: string, runId: string) => ["workflows", workflowId, "run", runId] as const,
  campaigns: ["campaigns"] as const,
  campaign: (id: string) => ["campaigns", id] as const,
  campaignStats: (id: string) => ["campaigns", id, "stats"] as const,
  campaignTemplates: (channel: string) => ["campaigns", "templates", channel] as const,
  suppressions: (channel: string, page: number) => ["campaigns", "suppressions", channel, page] as const,
  exports: (page: number) => ["exports", page] as const,
  supportTickets: (page: number) => ["support", "tickets", page] as const,
  supportTicket: (id: string) => ["support", "tickets", id] as const,
};

/** M8 Phase-3 keys (copilot threads + report vault). */
export const M8_QK = {
  copilotConversations: ["copilot", "conversations"] as const,
  copilotConversation: (id: string) => ["copilot", "conversations", id] as const,
  reports: (kind: string) => ["reports", kind] as const,
  report: (id: string) => ["reports", "detail", id] as const,
};
