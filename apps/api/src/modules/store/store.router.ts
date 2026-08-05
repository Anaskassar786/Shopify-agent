import { Router, type Router as ExpressRouter } from "express";
import { eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { storeSettings, stores, subscriptions, withStoreScope } from "@profit/db";
import { getRequestContext } from "../../lib/context/request-context";
import { NotFoundError } from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/store (P2). Beyond serving the settings screen, this endpoint is the
 * living proof of the tenant stack: RLS-scoped reads via withStoreScope() —
 * the integration tests assert cross-tenant invisibility through this exact path.
 */
export function storeRouter(deps: { db: ProfitDb; jwt: JwtService }): ExpressRouter {
  const router = Router();

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("store:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const result = await withStoreScope(deps.db, storeId, async (tx) => {
        const storeRows = await tx.select().from(stores).where(eq(stores.id, storeId)).limit(1);
        const store = storeRows[0];
        if (store === undefined) throw new NotFoundError("Store", storeId);
        const settings = await tx
          .select()
          .from(storeSettings)
          .where(eq(storeSettings.storeId, storeId))
          .limit(1);
        const sub = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.storeId, storeId))
          .limit(1);
        return {
          store,
          settings: settings[0] ?? null,
          subscription: sub[0] ?? null,
        };
      });
      res.status(200).json(successEnvelope(getRequestContext(), result));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
