import { Router, type Router as ExpressRouter } from "express";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import type { HealthService } from "./health.service";

/**
 * P5 health surface: /live (cheap), /ready (dependency probes), /health (aggregate).
 * Responses still use the standard envelope so dashboards/probes get one shape.
 */
export function healthRouter(healthService: HealthService): ExpressRouter {
  const router = Router();

  router.get("/live", (_req, res) => {
    res
      .status(200)
      .json(successEnvelope(getRequestContext(), healthService.liveness(), { message: "live" }));
  });

  router.get("/ready", async (_req, res, next) => {
    try {
      const report = await healthService.readiness();
      res
        .status(report.ready ? 200 : 503)
        .json(successEnvelope(getRequestContext(), report, { message: report.ready ? "ready" : "not ready" }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/health", async (_req, res, next) => {
    try {
      const readiness = await healthService.readiness();
      const report = { ...healthService.liveness(), readiness };
      res
        .status(readiness.ready ? 200 : 503)
        .json(successEnvelope(getRequestContext(), report, { message: readiness.ready ? "healthy" : "degraded" }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
