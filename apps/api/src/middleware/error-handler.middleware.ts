import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import type { ApiErrorItem } from "@profit/types";
import { AppError, ErrorCode, ValidationError } from "../lib/errors";
import { getRequestContext } from "../lib/context/request-context";
import { errorEnvelope } from "../lib/http/envelope";
import type { Logger } from "../lib/logger";

/** Body-parser syntax failures arrive as raw SyntaxError with this marker. */
function isBodyParseError(err: unknown): err is SyntaxError & { status: number } {
  return (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status?: unknown }).status === 400 &&
    "body" in err
  );
}

function toResponse(err: unknown): { status: number; items: readonly ApiErrorItem[] } {
  if (err instanceof ZodError) {
    const validation = ValidationError.fromZod(err.issues);
    return { status: 400, items: validation.fieldErrors };
  }
  if (err instanceof AppError) {
    const items: readonly ApiErrorItem[] =
      err.fieldErrors.length > 0 ? err.fieldErrors : [err.toErrorItem()];
    if (!err.expose) {
      return {
        status: err.httpStatus,
        items: [{ code: err.code, message: "An internal error occurred" }],
      };
    }
    return { status: err.httpStatus, items };
  }
  if (isBodyParseError(err)) {
    return {
      status: 400,
      items: [
        { code: ErrorCode.ValidationFailed, message: "Malformed JSON body" },
      ],
    };
  }
  return {
    status: 500,
    items: [{ code: ErrorCode.Internal, message: "An internal error occurred" }],
  };
}

/**
 * Global error handler — the ONLY place errors are serialized (P1: structured
 * error responses). Decides what the client may see; logs everything else with
 * request bindings. Stack traces never leave the process.
 */
export function errorHandlerMiddleware(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const ctx = getRequestContext();
    const { status, items } = toResponse(err);

    const logPayload = {
      requestId: ctx.requestId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      method: req.method,
      path: req.originalUrl.split("?")[0],
      statusCode: status,
      err,
    };
    if (status >= 500) {
      logger.error(logPayload, "request.failed");
    } else {
      logger.warn(logPayload, "request.rejected");
    }

    res.status(status).json(
      errorEnvelope(ctx, items, {
        message: status >= 500 ? "An internal error occurred" : items[0]?.message ?? "Request failed",
      }),
    );
  };
}
