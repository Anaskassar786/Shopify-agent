import type { Server } from "node:http";
import { createDbClient, probeDbConnection, type DbClient } from "@profit/db";
import { createApp } from "./app";
import { loadEnv, type Env } from "./config/env";
import { createLogger, type Logger } from "./lib/logger";
import { HealthService } from "./modules/health/health.service";

export interface RunningServer {
  readonly server: Server;
  readonly env: Env;
  readonly logger: Logger;
  readonly shutdown: () => Promise<void>;
}

const HOST = "0.0.0.0";

/**
 * Composition root: env → logger → infra probes → app. Everything a module
 * needs is constructed HERE and injected (P1: dependency injection) — modules
 * never construct their own clients.
 */
export async function startServer(): Promise<RunningServer> {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    service: "api",
    environment: env.NODE_ENV,
  });

  // Dedicated low-capacity pool for readiness probes; app data-plane pools are
  // created per module in later milestones and injected the same way.
  let db: DbClient | undefined;
  let dbProbe: (() => Promise<unknown>) | undefined;
  if (env.DATABASE_URL !== undefined) {
    db = createDbClient({ url: env.DATABASE_URL, maxConnections: 2 });
    const sql = db.sql;
    dbProbe = () => probeDbConnection(sql);
  } else {
    logger.warn("DATABASE_URL not configured — readiness will report the database as skipped");
  }

  const healthService = new HealthService({
    version: env.APP_VERSION,
    ...(dbProbe !== undefined ? { dbProbe } : {}),
  });

  const app = createApp({ env, logger, healthService });

  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(env.PORT, HOST, () => resolve(instance));
    instance.on("error", reject);
  });

  logger.info({ host: HOST, port: env.PORT, version: env.APP_VERSION }, "api.listening");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("api.shutdown.started");
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (db !== undefined) await db.close();
    logger.info("api.shutdown.complete");
  };

  process.once("SIGTERM", () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, "api.shutdown.failed");
      process.exitCode = 1;
    });
  });
  process.once("SIGINT", () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, "api.shutdown.failed");
      process.exitCode = 1;
    });
  });

  return { server, env, logger, shutdown };
}
