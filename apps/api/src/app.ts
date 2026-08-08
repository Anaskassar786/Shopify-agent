import compression from "compression";
import cors from "cors";
import express, { type Express, type Router as ExpressRouter } from "express";
import helmet from "helmet";
import type { Env } from "./config/env";
import type { Logger } from "@profit/logger";
import { errorHandlerMiddleware } from "./middleware/error-handler.middleware";
import { httpLoggerMiddleware } from "./middleware/http-logger.middleware";
import { notFoundMiddleware } from "./middleware/not-found.middleware";
import { requestContextMiddleware } from "./middleware/request-context.middleware";
import type { ErrorMonitor } from "@profit/monitoring";
import type { HealthService } from "./modules/health/health.service";
import { healthRouter } from "./modules/health/health.router";
import { createApiV1Router, type ApiV1Routers } from "./routes/v1/index";
import { mountSpa, type SpaMount } from "./static/spa";

export interface AppRouters {
  /** Mounted at /shopify when Shopify credentials are configured (always in prod). */
  readonly shopify?: ExpressRouter;
  readonly apiV1: ApiV1Routers;
  /** M7 public legal pages — mounted at /legal (unauthenticated, static content). */
  readonly legal: ExpressRouter;
}

export interface AppDeps {
  readonly env: Env;
  readonly logger: Logger;
  readonly healthService: HealthService;
  readonly routers: AppRouters;
  /**
   * Embedded-web static mount (M3). Registered between the API router and the
   * 404 envelope: mounting it after notFoundMiddleware would starve it, and
   * the embedded app would 404 in production (M7 wiring fix, regression-tested).
   */
  readonly spa?: SpaMount;
  /** Launch readiness (ADR 38): captures 5xx into the monitoring channel. */
  readonly errorMonitor?: ErrorMonitor;
}

/**
 * Middleware order is a contract (ARCHITECTURE §4.1). Two orderings matter most:
 *   1. The webhook route mounts BEFORE express.json — HMAC needs the raw body.
 *   2. Error handler is LAST — it is the only place errors are serialized.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  // One trusted hop (Railway proxy) so req.ip and secure cookies behave.
  app.set("trust proxy", 1);

  app.use(requestContextMiddleware());
  app.use(httpLoggerMiddleware(deps.logger));
  app.use(helmet(buildHelmetOptions()));
  app.use(cors(buildCorsOptions(deps.env)));
  app.use(compression());

  if (deps.routers.shopify !== undefined) {
    app.use(
      "/shopify/webhooks",
      express.raw({ type: "application/json", limit: "2mb" }),
    );
    app.use("/shopify", deps.routers.shopify);
  }

  app.use(express.json({ limit: "1mb" }));

  // Platform probes first among authed routes — they must work even when
  // application routes are degraded.
  app.use(healthRouter(deps.healthService));

  // Public legal pages (M7) — static content, unauthenticated by design;
  // registered before the SPA fallback so /legal/* never serves the app shell.
  app.use("/legal", deps.routers.legal);

  app.use("/api/v1", createApiV1Router(deps.routers.apiV1));

  // The SPA swallows only GET/HEAD for non-API paths; everything else falls
  // through to the structured 404 envelope below.
  if (deps.spa !== undefined) {
    mountSpa(app, deps.spa);
  }

  app.use(notFoundMiddleware());
  app.use(errorHandlerMiddleware(deps.logger, deps.errorMonitor));

  return app;
}

function buildHelmetOptions(): Parameters<typeof helmet>[0] {
  // Embedded-app CSP (M3): the shell must be frameable ONLY inside Shopify
  // Admin / the shop admin domain, and App Bridge + analytics beacons load
  // from Shopify's CDN/API hosts. Everything else stays 'self'.
  return {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "https://cdn.shopify.com"],
        "frame-ancestors": ["https://admin.shopify.com", "https://*.myshopify.com"],
        "img-src": ["'self'", "data:", "https://cdn.shopify.com"],
        "connect-src": [
          "'self'",
          "wss:",
          "https://cdn.shopify.com",
          "https://monorail-edge.shopifysvc.com",
        ],
        "style-src": ["'self'", "'unsafe-inline'"],
        "frame-src": ["https://admin.shopify.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  };
}

function buildCorsOptions(env: Env): cors.CorsOptions {
  // Embedded Shopify apps load from the merchant admin origin; the app URL
  // covers first-party browser calls. Credentials stay OFF — session tokens
  // travel in the Authorization header, not cookies (P5).
  return {
    origin: [env.APP_URL],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "x-request-id"],
    credentials: false,
    maxAge: 600,
  };
}
