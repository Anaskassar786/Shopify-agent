import { Router, type Router as ExpressRouter } from "express";

export interface ApiV1Routers {
  readonly auth: ExpressRouter;
  readonly store: ExpressRouter;
  readonly sync: ExpressRouter;
  readonly analytics: ExpressRouter;
  readonly products: ExpressRouter;
  readonly customers: ExpressRouter;
  readonly orders: ExpressRouter;
  readonly inventory: ExpressRouter;
  readonly notifications: ExpressRouter;
  readonly search: ExpressRouter;
  readonly auditLogs: ExpressRouter;
  readonly subscription: ExpressRouter;
  readonly recommendations: ExpressRouter;
  readonly ai: ExpressRouter;
  readonly automation: ExpressRouter;
  readonly billing: ExpressRouter;
  readonly engagement: ExpressRouter;
  readonly admin: ExpressRouter;
  /** M6 Automation Center plane. */
  readonly workflows: ExpressRouter;
  readonly campaigns: ExpressRouter;
  readonly exports: ExpressRouter;
  readonly support: ExpressRouter;
  /** Public tracking endpoints (no session — HMAC token is the authorization). */
  readonly tracking: ExpressRouter;
  /** M8 Phase 3: copilot Q&A + enterprise report vault. */
  readonly copilot: ExpressRouter;
  readonly reports: ExpressRouter;
}

/**
 * /api/v1 root. Domain modules register here as they land:
 *   M1: auth, store, (shopify mounted at root)
 *   M2: sync, analytics, products, customers, orders, inventory
 *   M3: notifications, search, audit-logs, subscription (+ WS at /api/v1/realtime)
 *   M4: recommendations, ai, automation
 *   M5: billing (charges), engagement (growth telemetry), admin (platform panel)
 *   M6: workflows, campaigns, exports, support, admin writes, tracking (public)
 *   M8: copilot (merchant Q&A), reports (enterprise period reports)
 * Versioning rule (P2): breaking changes ship under /api/v2; v1 stays stable.
 */
export function createApiV1Router(modules: ApiV1Routers): ExpressRouter {
  const router = Router();
  router.use("/auth", modules.auth);
  router.use("/store", modules.store);
  router.use("/sync", modules.sync);
  router.use("/analytics", modules.analytics);
  router.use("/products", modules.products);
  router.use("/customers", modules.customers);
  router.use("/orders", modules.orders);
  router.use("/inventory", modules.inventory);
  router.use("/notifications", modules.notifications);
  router.use("/search", modules.search);
  router.use("/audit-logs", modules.auditLogs);
  router.use("/subscription", modules.subscription);
  router.use("/recommendations", modules.recommendations);
  router.use("/ai", modules.ai);
  router.use("/automation", modules.automation);
  router.use("/billing", modules.billing);
  router.use("/engagement", modules.engagement);
  router.use("/admin", modules.admin);
  router.use("/workflows", modules.workflows);
  router.use("/campaigns", modules.campaigns);
  router.use("/exports", modules.exports);
  router.use("/support", modules.support);
  router.use("/t", modules.tracking);
  router.use("/copilot", modules.copilot);
  router.use("/reports", modules.reports);
  return router;
}
