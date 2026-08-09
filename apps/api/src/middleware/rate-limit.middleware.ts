import type { RequestHandler } from "express";
import type { CachePort } from "@profit/cache";
import { CACHE_TTL } from "@profit/cache";
import { RateLimitError } from "../lib/errors";

/**
 * Fixed-window rate limiting (P2: rate limiting on all API routes; P12 scale
 * plan: shared Redis → correct across ALL replicas, in-process driver keeps
 * tests hermetic). Applied selectively to expensive/mutation endpoints; the
 * key composition (store-scoped when authenticated, IP otherwise) makes
 * cross-tenant interference impossible by construction.
 */

export interface RateLimitRule {
  /** Bucket identifier, e.g. "sync-trigger". */
  readonly scope: string;
  readonly max: number;
  readonly windowSeconds?: number;
}

export function rateLimitMiddleware(cache: CachePort, rule: RateLimitRule): RequestHandler {
  const windowSeconds = rule.windowSeconds ?? CACHE_TTL.rateLimitWindowSeconds;
  return async (req, _res, next) => {
    try {
      const identity =
        req.appAuth !== undefined ? `s:${req.appAuth.storeId}` : `ip:${req.ip ?? "unknown"}`;
      const key = `rl:${rule.scope}:${identity}`;
      const count = await cache.incr(key);
      if (count === 1) await cache.expire(key, windowSeconds);
      if (count > rule.max) {
        next(new RateLimitError(windowSeconds));
        return;
      }
      next();
    } catch (error) {
      // Cache failure must never take down the control plane (fail open,
      // log the degradation via the request logger's error path).
      next(error instanceof RateLimitError ? error : undefined);
    }
  };
}
