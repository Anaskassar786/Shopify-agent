import { Router, type Router as ExpressRouter } from "express";

/**
 * /api/v1 root. Domain modules register here as they land:
 *   M1: auth, shopify (oauth + webhooks)
 *   M2: stores, products, customers, orders, inventory, sync
 *   M4: recommendations, automation
 *   M5: billing, admin
 * Versioning rule (P2): breaking changes ship under /api/v2; v1 stays stable.
 */
export function createApiV1Router(): ExpressRouter {
  const router = Router();
  return router;
}
