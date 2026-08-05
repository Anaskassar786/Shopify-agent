import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import { ValidationError } from "../../lib/errors";
import { InvalidShopDomainError } from "@profit/shopify";
import type { ShopifyOauthService } from "./oauth.service";
import type { ShopifyWebhookService } from "./webhooks/webhook.service";
import type { Logger } from "@profit/logger";

/**
 * Shopify surface:
 *   GET  /shopify/install     → 302 into Shopify's authorize screen
 *   GET  /shopify/oauth/callback & /shopify/callback → verify + provision + redirect
 *   POST /shopify/webhooks    → HMAC-verified intake (raw body — wired in app.ts)
 *
 * Redirects are responses; errors fall through to the global handler which
 * answers with the standard envelope (Webhook non-2xx triggers Shopify retry —
 * only signature/validation failures should ever produce it here).
 */
export function shopifyRouter(deps: {
  oauth: ShopifyOauthService;
  webhooks: ShopifyWebhookService;
  logger: Logger;
}): ExpressRouter {
  const router = Router();

  router.get("/install", async (req, res, next) => {
    try {
      const shop = req.query["shop"];
      if (typeof shop !== "string" || shop === "") {
        throw new ValidationError("shop query parameter is required");
      }
      const url = await deps.oauth.buildInstallUrl(shop);
      res.redirect(302, url);
    } catch (error) {
      if (error instanceof InvalidShopDomainError) {
        next(new ValidationError("invalid shop domain"));
        return;
      }
      next(error);
    }
  });

  const callbackHandler = async (req: Parameters<Parameters<typeof router.get>[1]>[0], res: Parameters<Parameters<typeof router.get>[1]>[1], next: Parameters<Parameters<typeof router.get>[1]>[2]) => {
    try {
      const query: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === "string" || Array.isArray(value)) {
          query[key] = value as string | string[];
        }
      }
      const redirectUrl = await deps.oauth.handleCallback(query, { ip: req.ip });
      res.redirect(302, redirectUrl);
    } catch (error) {
      if (error instanceof InvalidShopDomainError) {
        next(new ValidationError("invalid shop domain"));
        return;
      }
      next(error);
    }
  };
  router.get("/callback", callbackHandler);
  router.get("/oauth/callback", callbackHandler);

  router.post("/webhooks", async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        // Raw-body wiring mistake must be LOUD (would silently break HMAC).
        throw new Error("webhook route must receive a raw Buffer body (see app.ts wiring)");
      }
      const outcome = await deps.webhooks.process({
        shopDomainHeader: req.header("x-shopify-shop-domain"),
        topicHeader: req.header("x-shopify-topic"),
        webhookIdHeader: req.header("x-shopify-webhook-id"),
        hmacHeader: req.header("x-shopify-hmac-sha256"),
        rawBody: req.body,
        ip: req.ip,
      });
      deps.logger.info({ outcome }, "shopify.webhook.acknowledged");
      res
        .status(200)
        .json(successEnvelope(getRequestContext(), outcome, { message: "webhook acknowledged" }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/** Body validation helper for JSON routers (Zod everywhere, P2). */
export function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ValidationError.fromZod(result.error.issues);
  }
  return result.data;
}
