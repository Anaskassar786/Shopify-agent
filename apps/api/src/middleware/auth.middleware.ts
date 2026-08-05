import type { RequestHandler } from "express";
import { eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { stores } from "@profit/db";
import { StoreStatus } from "@profit/types";
import { patchRequestContext } from "../lib/context/request-context";
import { AuthenticationError, ForbiddenError } from "../lib/errors";
import { extractBearerToken } from "../lib/shopify/session-token";
import type { JwtService } from "../modules/auth/jwt.service";

/**
 * AuthN/AuthZ chain (P2: every request validates merchant → store → permission;
 * ARCHITECTURE §4.1). requireAppAuth verifies the first-party JWT and pins the
 * tenant into the ALS context; requireActiveStore re-validates store liveness
 * per request (suspend/uninstall takes effect immediately); requirePermission
 * enforces the RBAC claim set.
 */

export function requireAppAuth(jwt: JwtService): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = extractBearerToken(req.header("authorization"));
      const claims = await jwt.verifyAccessToken(token);
      req.appAuth = claims;
      patchRequestContext({ userId: claims.userId, storeId: claims.storeId });
      next();
    } catch (error) {
      next(
        error instanceof AuthenticationError
          ? error
          : new AuthenticationError("authentication failed"),
      );
    }
  };
}

export function requirePermission(permission: string): RequestHandler {
  return (req, _res, next) => {
    const claims = req.appAuth;
    if (claims === undefined) {
      next(new AuthenticationError("authentication required before permission checks"));
      return;
    }
    if (!claims.permissions.includes(permission)) {
      next(
        new ForbiddenError(`missing permission: ${permission}`, {
          permission,
        }),
      );
      return;
    }
    next();
  };
}

export function requireActiveStore(db: ProfitDb): RequestHandler {
  return async (req, _res, next) => {
    try {
      const claims = req.appAuth;
      if (claims === undefined) {
        throw new AuthenticationError("authentication required before store validation");
      }
      const rows = await db
        .select({ status: stores.status })
        .from(stores)
        .where(eq(stores.id, claims.storeId))
        .limit(1);
      const store = rows[0];
      if (store === undefined) throw new ForbiddenError("store not found for session");
      if (store.status !== StoreStatus.Active) {
        throw new ForbiddenError("store is suspended or uninstalled");
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
