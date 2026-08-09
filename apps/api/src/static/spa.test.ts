import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@profit/logger";
import { createSpaHandler, mountSpa } from "./spa";
import { notFoundMiddleware } from "../middleware/not-found.middleware";

/**
 * Embedded-app hosting (M3): runtime key injection (build-once-deploy-many),
 * asset caching discipline, SPA fallback boundaries (API prefixes keep their
 * JSON envelopes), and the missing-bundle degradation path.
 */

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: "fatal", service: "spa-test", environment: "test", destination: sink });

let workdir = "";
let app: express.Express;

beforeAll(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "spa-fixture-"));
  mkdirSync(path.join(workdir, "assets"), { recursive: true });
  writeFileSync(
    path.join(workdir, "index.html"),
    '<!doctype html><html><head><meta name="shopify-api-key" content="%SHOPIFY_API_KEY%" /></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(path.join(workdir, "assets", "app-1a2b3c.js"), "console.log('bundle');");

  const mount = createSpaHandler({
    distDir: workdir,
    shopifyApiKey: "test-api-key-123",
    logger,
  });
  expect(mount.available).toBe(true);

  app = express();
  mountSpa(app, mount);
  app.use(notFoundMiddleware());
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("SPA handler", () => {
  it("serves index.html with the runtime-injected API key and no-cache", async () => {
    const res = await request(app).get("/").expect(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.text).toContain('content="test-api-key-123"');
    expect(res.text).not.toContain("%SHOPIFY_API_KEY%");
  });

  it("SPA fallback serves index.html for deep client routes", async () => {
    const res = await request(app).get("/settings/sync").expect(200);
    expect(res.text).toContain('id="root"');
  });

  it("hashed assets are cacheable; unknown assets 404 as JSON", async () => {
    const asset = await request(app).get("/assets/app-1a2b3c.js").expect(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.text).toContain("bundle");

    const missing = await request(app).get("/assets/gone-x9y8z7.js").expect(404);
    expect(missing.body.success).toBe(false);
  });

  it("API prefixes fall through to the JSON 404 envelope, never to HTML", async () => {
    const api = await request(app).get("/api/v1/definitely-not-a-route").expect(404);
    expect(api.headers["content-type"]).toContain("application/json");
    expect(api.body.success).toBe(false);

    const health = await request(app).get("/health").expect(404);
    expect(health.body.success).toBe(false);
  });

  it("non-GET methods never hit the SPA fallback", async () => {
    const res = await request(app).post("/dashboard").expect(404);
    expect(res.body.success).toBe(false);
  });

  it("missing bundle degrades to pass-through (available=false)", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "spa-empty-"));
    const mount = createSpaHandler({ distDir: empty, shopifyApiKey: "k", logger });
    expect(mount.available).toBe(false);
    const bare = express();
    mountSpa(bare, mount);
    bare.use(notFoundMiddleware());
    const res = await request(bare).get("/").expect(404);
    expect(res.body.success).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });
});
