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
}

/**
 * /api/v1 root. Domain modules register here as they land:
 *   M1: auth, store, (shopify mounted at root)
 *   M2: sync, analytics, products, customers, orders, inventory
 *   M4: recommendations, automation
 *   M5: billing, admin
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
  return router;
}
