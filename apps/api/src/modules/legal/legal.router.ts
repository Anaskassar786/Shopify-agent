import { Router, type Response } from "express";
import type { CachePort } from "@profit/cache";
import { rateLimitMiddleware } from "../../middleware/rate-limit.middleware";
import { LEGAL_DOCUMENTS, legalDocumentBySlug } from "./content";
import { renderLegalDocument, renderLegalIndex } from "./legal-pages";

/**
 * Public legal surface (M7, ADR 25/26). Ungated by design — app review,
 * partner-directory links, and merchants must reach policies without a
 * session. Responses are pure functions of bundled content: no database, no
 * tenant data, so the surface cannot leak or be DB-bombed; a dedicated IP
 * limiter caps scraping abuse. `no-cache` keeps policy edits instantaneous
 * (a stale ToS is a legal bug).
 */

export interface LegalRouterDeps {
  readonly cache: CachePort;
  readonly entityName: string;
  readonly supportEmail: string | null;
  readonly appUrl: string;
}

/** ~2 req/s sustained per IP is far beyond genuine reading; trips return the typed 429 envelope. */
const LEGAL_RATE_RULE = { scope: "legal-pages", max: 60, windowSeconds: 60 } as const;

export function legalRouter(deps: LegalRouterDeps): Router {
  const router = Router();
  const identity = {
    entityName: deps.entityName,
    supportEmail: deps.supportEmail,
    appUrl: deps.appUrl,
  };

  const send = (html: string, res: Response): void => {
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  };

  router.get("/", rateLimitMiddleware(deps.cache, LEGAL_RATE_RULE), (_req, res) => {
    send(renderLegalIndex(LEGAL_DOCUMENTS, identity), res);
  });

  router.get("/:slug", rateLimitMiddleware(deps.cache, LEGAL_RATE_RULE), (req, res, next) => {
    const doc = legalDocumentBySlug(req.params["slug"] ?? "");
    if (doc === null) {
      next();
      return;
    }
    send(renderLegalDocument(doc, identity), res);
  });

  return router;
}
