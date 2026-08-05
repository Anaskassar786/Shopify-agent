import type { RequestHandler } from "express";
import { getRequestContext } from "../lib/context/request-context";
import type { Logger } from "../lib/logger";

/**
 * Request/response log line per completed request (P5). Duration measured with
 * hrtime; level escalates with status class. Bodies/headers are never logged
 * here — redaction in the logger guards everything downstream.
 */
export function httpLoggerMiddleware(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const ctx = getRequestContext();
      const level =
        res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      logger[level](
        {
          requestId: ctx.requestId,
          storeId: ctx.storeId,
          userId: ctx.userId,
          method: req.method,
          path: (req.baseUrl + req.path) || req.originalUrl.split("?")[0],
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          ip: req.ip,
        },
        "http.request",
      );
    });
    next();
  };
}
