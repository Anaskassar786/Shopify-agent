import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  runWithRequestContext,
} from "../lib/context/request-context";

export const REQUEST_ID_HEADER = "x-request-id";

/** Accept client-supplied ids only when they are a sane shape (log-injection safe). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function resolveRequestId(req: Request): string {
  const incoming = req.header(REQUEST_ID_HEADER);
  if (incoming && SAFE_REQUEST_ID.test(incoming)) return incoming;
  return randomUUID();
}

/**
 * First middleware in the pipeline: assigns/echoes the request id and opens the
 * ALS scope that all later code (logging, tenant scoping, envelope) reads from.
 */
export function requestContextMiddleware(): RequestHandler {
  return (req, res, next: NextFunction) => {
    const requestId = resolveRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, () => next());
  };
}
