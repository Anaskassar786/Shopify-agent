import type { RequestHandler } from "express";
import { ErrorCode } from "../lib/errors";
import { getRequestContext } from "../lib/context/request-context";
import { errorEnvelope } from "../lib/http/envelope";

/** Terminal handler for unmatched routes — still a structured envelope. */
export function notFoundMiddleware(): RequestHandler {
  return (req, res) => {
    const ctx = getRequestContext();
    res.status(404).json(
      errorEnvelope(
        ctx,
        [
          {
            code: ErrorCode.NotFound,
            message: `Route not found: ${req.method} ${req.originalUrl.split("?")[0]}`,
          },
        ],
        { message: "Route not found" },
      ),
    );
  };
}
