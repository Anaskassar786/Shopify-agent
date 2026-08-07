import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import {
  TRACKING_PIXEL_GIF,
  TrackingRecipientNotFoundError,
  TrackingService,
  TrackingTokenError,
} from "@profit/automation";
import type { Logger } from "@profit/logger";
import { MaintenanceError } from "../../lib/errors";

/**
 * /api/v1/t/* (M6, PUBLIC — no session by design; the HMAC token IS the
 * authorization). The pixel must be cheapest-possible: one recording insert,
 * no-store bytes. Tampered/expired-mint tokens fail closed (404) — a valid
 * token is only ever minted for real recipients server-side.
 *
 *   GET /t/o/:token   → 1×1 GIF + OPEN event
 *   GET /t/c/:token   → 302 to the wrapped url + CLICK event
 *   GET /t/u/:token   → unsubscribe confirmation page + suppression row
 */
export function trackingRouter(deps: {
  db: ProfitDb;
  logger: Logger;
  /** HMAC mint/verify secret; the surface 503s without it (honest unconfigured). */
  trackingSecret: string | undefined;
}): ExpressRouter {
  const router = Router();
  const tracking = new TrackingService(deps.db);

  function requireSecret(): string {
    if (deps.trackingSecret === undefined || deps.trackingSecret === "") {
      throw new MaintenanceError("Tracking is not configured for this environment");
    }
    return deps.trackingSecret;
  }

  router.get("/o/:token", async (req, res, next) => {
    try {
      const secret = requireSecret();
      const token = req.params["token"]!;
      try {
        await tracking.recordOpen(secret, token);
      } catch (error) {
        // Pixel requests must never 4xx: email clients and image proxies
        // prefetch aggressively; a failed OPEN is honest (nothing recorded),
        // a broken pixel would corrupt the merchant's own open metrics trust.
        if (!(error instanceof TrackingRecipientNotFoundError) && !(error instanceof TrackingTokenError)) throw error;
        deps.logger.warn({ token: token.slice(0, 12) }, "tracking.open.invalid_token");
      }
      res.status(200);
      res.setHeader("content-type", "image/gif");
      res.setHeader("content-length", String(TRACKING_PIXEL_GIF.length));
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
      res.end(TRACKING_PIXEL_GIF);
    } catch (error) {
      next(error);
    }
  });

  router.get("/c/:token", async (req, res, next) => {
    try {
      const secret = requireSecret();
      const outcome = await tracking.recordClick(secret, req.params["token"]!);
      res.redirect(302, outcome.url);
    } catch (error) {
      if (error instanceof TrackingRecipientNotFoundError || error instanceof TrackingTokenError) {
        res.status(404).json({ error: "link expired or invalid" });
        return;
      }
      next(error);
    }
  });

  router.get("/u/:token", async (req, res, next) => {
    try {
      const secret = requireSecret();
      const outcome = await tracking.recordUnsubscribe(secret, req.params["token"]!);
      const channelLabel = outcome.channel === "SMS" ? "SMS" : "email";
      res.status(200);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Unsubscribed</title>` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
          `<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:80vh;margin:0;background:#f6f6f7;color:#202223}main{background:#fff;border-radius:12px;padding:32px;max-width:420px;box-shadow:0 1px 4px rgba(0,0,0,.08)}</style>` +
          `</head><body><main><h1>You are unsubscribed</h1>` +
          `<p><strong>${escapeHtml(outcome.destination)}</strong> will no longer receive ${channelLabel} messages from this store.</p>` +
          `<p>If this was a mistake, reply to any previous email or contact the store directly.</p>` +
          `</main></body></html>`,
      );
    } catch (error) {
      if (error instanceof TrackingRecipientNotFoundError || error instanceof TrackingTokenError) {
        res.status(404);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Invalid link</title></head>` +
            `<body><p>This unsubscribe link is invalid or has already been superseded. You can manage preferences from any email footer.</p></body></html>`,
        );
        return;
      }
      next(error);
    }
  });

  return router;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
