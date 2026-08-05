import compression from "compression";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Env } from "./config/env";
import type { Logger } from "./lib/logger";
import { errorHandlerMiddleware } from "./middleware/error-handler.middleware";
import { httpLoggerMiddleware } from "./middleware/http-logger.middleware";
import { notFoundMiddleware } from "./middleware/not-found.middleware";
import { requestContextMiddleware } from "./middleware/request-context.middleware";
import type { HealthService } from "./modules/health/health.service";
import { healthRouter } from "./modules/health/health.router";
import { createApiV1Router } from "./routes/v1/index";

export interface AppDeps {
  readonly env: Env;
  readonly logger: Logger;
  readonly healthService: HealthService;
}

/**
 * Middleware order is a contract (ARCHITECTURE §4.1): context → logging →
 * security headers → CORS → compression → body parsing → routes → 404 → errors.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  // One trusted hop (Railway proxy) so req.ip and secure cookies behave.
  app.set("trust proxy", 1);

  app.use(requestContextMiddleware());
  app.use(httpLoggerMiddleware(deps.logger));
  app.use(helmet());
  app.use(cors(buildCorsOptions(deps.env)));
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));

  // Platform probes first — they must work even when app routes are degraded.
  app.use(healthRouter(deps.healthService));

  app.use("/api/v1", createApiV1Router());

  app.use(notFoundMiddleware());
  app.use(errorHandlerMiddleware(deps.logger));

  return app;
}

function buildCorsOptions(env: Env): cors.CorsOptions {
  // Embedded Shopify apps are loaded from the merchant admin origin; the app URL
  // covers first-party browser calls. Credentials stay OFF (session tokens travel
  // in the Authorization header, not cookies — P5).
  return {
    origin: [env.APP_URL],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "x-request-id"],
    credentials: false,
    maxAge: 600,
  };
}
