import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import { requireAppAuth } from "../../middleware/auth.middleware";
import type { JwtService } from "./jwt.service";
import type { AuthService } from "./auth.service";
import { parseBody } from "../shopify/shopify.router";

/**
 * /api/v1/auth (P2: session exchange, refresh rotation, /me).
 * "session" is the ONLY endpoint that accepts a Shopify session token;
 * everything else in the API speaks first-party JWTs exclusively.
 */
export function authRouter(deps: { auth: AuthService; jwt: JwtService }): ExpressRouter {
  const router = Router();

  const sessionSchema = z.object({
    sessionToken: z.string().min(10).max(8192, "session token too large"),
  });

  router.post("/session", async (req, res, next) => {
    try {
      const body = parseBody(sessionSchema, req.body);
      const result = await deps.auth.loginWithShopifySession(body.sessionToken, {
        ...(req.ip !== undefined ? { ip: req.ip } : {}),
        userAgent: req.header("user-agent"),
      });
      res.status(200).json(successEnvelope(getRequestContext(), result, { message: "authenticated" }));
    } catch (error) {
      next(error);
    }
  });

  const refreshSchema = z.object({
    refreshToken: z.string().min(20).max(512),
  });

  router.post("/refresh", async (req, res, next) => {
    try {
      const body = parseBody(refreshSchema, req.body);
      const result = await deps.auth.rotateRefreshToken(body.refreshToken, {
        ...(req.ip !== undefined ? { ip: req.ip } : {}),
      });
      res.status(200).json(successEnvelope(getRequestContext(), result, { message: "token rotated" }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireAppAuth(deps.jwt), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const profile = await deps.auth.profileFor(req.appAuth);
      res.status(200).json(successEnvelope(getRequestContext(), profile));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
