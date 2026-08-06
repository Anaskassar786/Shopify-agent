import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express, { type Express, type RequestHandler } from "express";
import type { Logger } from "@profit/logger";

/**
 * Production hosting of the embedded web app (M3). The API serves the Vite
 * bundle so one Railway service exposes API + app shell on one origin — the
 * requirement for App Bridge/session-token flows (same-site fetch + cookies).
 *
 * Rules:
 *  - `index.html` is runtime-templated: %SHOPIFY_API_KEY% is injected from env
 *    at boot so ONE build serves staging + production (build once, deploy many).
 *  - /assets/* are Vite content-hashed → immutable caching; index.html never.
 *  - SPA fallback only swallows GET/HEAD for non-API paths: /api, /shopify,
 *    /live, /ready, /health keep their JSON/contracts and 404 envelopes.
 *  - Missing dist (pure API deploy, or dev) ⇒ pass-through → 404 envelope;
 *    Vite owns the app in development.
 */

const API_PREFIXES = ["/api/", "/shopify", "/live", "/ready", "/health"] as const;

export interface SpaMount {
  readonly handler: RequestHandler;
  readonly available: boolean;
  readonly distDir: string;
}

export function createSpaHandler(deps: {
  distDir: string;
  shopifyApiKey: string | undefined;
  logger: Logger;
}): SpaMount {
  const distDir = path.resolve(deps.distDir);
  const indexPath = path.join(distDir, "index.html");
  const available = existsSync(indexPath);

  if (!available) {
    deps.logger.warn({ distDir }, "spa.dist.missing — web app not served by this process");
    return {
      available: false,
      distDir,
      handler: (_req, _res, next) => next(),
    };
  }

  let indexHtmlPromise: Promise<string> | null = null;
  const loadIndexHtml = (): Promise<string> => {
    indexHtmlPromise ??= readFile(indexPath, "utf8").then((html) =>
      html.replaceAll("%SHOPIFY_API_KEY%", deps.shopifyApiKey ?? ""),
    );
    return indexHtmlPromise;
  };

  const assetsHandler = express.static(distDir, {
    index: false,
    immutable: true,
    maxAge: "365d",
    setHeaders(res, filePath) {
      // Never cache-bust-fail hashed assets; anything outside /assets gets a
      // short cache so rollback propagates quickly.
      if (!filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=300");
      }
    },
  });

  const handler: RequestHandler = (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    const pathname = req.path;
    if (API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      next();
      return;
    }
    // Static asset hit (file exists) → express.static; otherwise SPA fallback.
    const assetExt = path.extname(pathname) !== "" && pathname !== "/index.html";
    if (assetExt) {
      assetsHandler(req, res, next);
      return;
    }
    loadIndexHtml()
      .then((html) => {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(200).send(html);
      })
      .catch(next);
  };

  return { handler, available, distDir };
}

export function mountSpa(app: Express, mount: SpaMount): void {
  if (!mount.available) return;
  app.use(mount.handler);
}
