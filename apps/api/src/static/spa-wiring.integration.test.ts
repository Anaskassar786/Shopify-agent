import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestEnvironment, type TestEnvironment } from "../test-support/harness";

/**
 * SPA production-serving contract (M7 wiring fix — regression-proof).
 *
 * The defect this locks out: mounting the SPA handler AFTER the 404 envelope
 * starves it — every non-API GET (including `/`) answered JSON 404 and the
 * embedded app never rendered in production, while the handler's own unit
 * tests (correct order) stayed green. This suite boots the full composition
 * root with a dist fixture and proves the real order: apiV1 → spa → 404.
 */

let workdir = "";
let env: TestEnvironment;

beforeAll(async () => {
  workdir = mkdtempSync(path.join(tmpdir(), "spa-wiring-"));
  mkdirSync(path.join(workdir, "assets"), { recursive: true });
  writeFileSync(
    path.join(workdir, "index.html"),
    '<!doctype html><html><head><meta name="shopify-api-key" content="%SHOPIFY_API_KEY%" /></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(path.join(workdir, "assets", "app-9f8e7d.js"), "console.log('bundle');");

  env = await buildTestEnvironment({ spaDistDir: workdir });
}, 120_000);

afterAll(async () => {
  await env.close();
  rmSync(workdir, { recursive: true, force: true });
});

describe("SPA production serving through the real composition root", () => {
  it("serves index.html at / with the runtime-injected key (would 404 JSON when starved)", async () => {
    const res = await request(env.app).get("/").expect(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.text).toContain('<meta name="shopify-api-key" content="test_api_key"');
  });

  it("serves index.html for deep client routes (embedded shell owns them)", async () => {
    for (const route of ["/campaigns", "/automation", "/billing/plans"]) {
      const res = await request(env.app).get(route).expect(200);
      expect(res.headers["content-type"]).toContain("text/html");
    }
  });

  it("keeps API contracts: unknown /api/v1 paths still answer the JSON 404 envelope", async () => {
    const res = await request(env.app).get("/api/v1/definitely-not-a-route").expect(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toMatchObject({ success: false });
  });

  it("keeps probe contracts: /live stays the JSON liveness payload", async () => {
    const res = await request(env.app).get("/live").expect(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toMatchObject({ success: true });
  });

  it("serves hashed assets immutably and never leaks files outside dist", async () => {
    const asset = await request(env.app).get("/assets/app-9f8e7d.js").expect(200);
    expect(asset.headers["cache-control"]).toContain("immutable");

    // Path traversal collapses to a client route (node normalizes before
    // Express): the SPA fallback may answer HTML — but the FILE bytes must
    // never leak. express.static stays root-confined either way.
    const traversal = await request(env.app).get("/../../etc/passwd");
    expect(traversal.status).not.toBe(500);
    expect(traversal.text).not.toContain("root:"); // /etc/passwd signature
    await request(env.app).get("/etc/passwd").expect(200).expect("content-type", /text\/html/);
  });

  it("POST to a non-API path falls through to the JSON 404 envelope, never to HTML", async () => {
    const res = await request(env.app).post("/campaigns").send({}).expect(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});
