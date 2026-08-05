import { Router, type Router as ExpressRouter } from "express";

export interface ApiV1Routers {
  readonly auth: ExpressRouter;
  readonly store: ExpressRouter;
}

/**
 * /api/v1 root. Domain modules register here as they land:
 *   M1: auth, store, (shopify mounted at root)
 *   M2: products, customers, orders, inventory, sync
 *   M4: recommendations, automation
 *   M5: billing, admin
 * Versioning rule (P2): breaking changes ship under /api/v2; v1 stays stable.
 */
export function createApiV1Router(modules: ApiV1Routers): ExpressRouter {
  const router = Router();
  router.use("/auth", modules.auth);
  router.use("/store", modules.store);
  return router;
}
