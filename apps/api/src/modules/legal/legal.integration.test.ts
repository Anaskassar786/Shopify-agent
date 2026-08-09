import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestEnvironment,
  TEST_LEGAL_ENTITY,
  TEST_SUPPORT_EMAIL,
  type TestEnvironment,
} from "../../test-support/harness";

/**
 * Public legal surface (M7): unauthenticated reachability (app-review gate),
 * env-owned identity, response contracts, and the IP rate limiter — all
 * through the production-shaped composition root.
 */

let env: TestEnvironment;

beforeAll(async () => {
  env = await buildTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env.close();
});

describe("GET /legal — public policy pages", () => {
  it("serves the index without any credentials, listing the mandated P7 set", async () => {
    const res = await request(env.app).get("/legal/").expect(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    for (const slug of ["privacy", "terms", "refunds", "acceptable-use", "security"]) {
      expect(res.text).toContain(`/legal/${slug}`);
    }
  });

  it("serves the privacy policy with identity interpolated from config, never tenant data", async () => {
    const res = await request(env.app).get("/legal/privacy").expect(200);
    expect(res.text).toContain("<h1>Privacy Policy</h1>");
    expect(res.text).toContain(TEST_LEGAL_ENTITY);
    expect(res.text).toContain(TEST_SUPPORT_EMAIL);
    expect(res.text).toContain("Effective 2026-08-07");
    // Security posture: the global CSP is present on legal pages too.
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors");
  });

  it("serves every document in the set with matching titles", async () => {
    const expectations: Record<string, string> = {
      terms: "<h1>Terms of Service</h1>",
      refunds: "<h1>Refund Policy</h1>",
      "acceptable-use": "<h1>Acceptable Use Policy</h1>",
      security: "<h1>Security Policy</h1>",
    };
    for (const [slug, title] of Object.entries(expectations)) {
      const res = await request(env.app).get(`/legal/${slug}`).expect(200);
      expect(res.text).toContain(title);
    }
  });

  it("answers unknown slugs with the structured 404 envelope, not the SPA shell", async () => {
    const res = await request(env.app).get("/legal/cookie-jar-nonsense").expect(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toMatchObject({ success: false });
  });

  it("rate-limits sustained scraping by IP with the typed 429 envelope", async () => {
    // The app trusts one proxy hop, so X-Forwarded-For sets req.ip; a
    // dedicated source IP keeps this suite's 61-request burst out of the
    // shared fixed window other tests count against (per-identity isolation
    // is the limiter's design, so use it rather than weaken the rule).
    const burnIp = { "X-Forwarded-For": "10.66.0.66" };
    let lastStatus = 200;
    for (let i = 0; i < 61; i += 1) {
      const res = await request(env.app).get("/legal/privacy").set(burnIp);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
