import { createServer, type Server } from "node:http";
import type { Logger } from "@profit/logger";

/**
 * Worker probes — deliberately dependency-free (P5 health checks run even
 * when the event loop is saturated by job traffic; a framework router adds
 * nothing here). /live: process up. /ready: dependencies up (DB probe +
 * queue-started flag); the orchestrator removes the worker from service on
 * failures instead of an ever-running zombie.
 */
export interface HealthServerOptions {
  readonly logger: Logger;
  readonly port: number;
  readonly probes: {
    readonly database: () => Promise<void>;
    readonly queueStarted: () => boolean;
  };
}

export function startHealthServer(options: HealthServerOptions): Server {
  const server = createServer((req, res) => {
    const reply = (status: number, body: Record<string, unknown>): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" || req.url === undefined) {
      reply(404, { status: "not_found" });
      return;
    }
    if (req.url === "/live") {
      reply(200, { status: "ok" });
      return;
    }
    if (req.url === "/ready") {
      void (async () => {
        try {
          await options.probes.database();
          if (!options.probes.queueStarted()) {
            throw new Error("queue consumer not started");
          }
          reply(200, { status: "ready" });
        } catch (error) {
          options.logger.warn({ err: error }, "worker.readiness.failed");
          reply(503, { status: "not_ready" });
        }
      })();
      return;
    }
    reply(404, { status: "not_found" });
  });

  server.listen(options.port, "0.0.0.0");
  return server;
}
