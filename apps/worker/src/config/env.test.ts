import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./env";

describe("loadWorkerEnv", () => {
  it("applies development defaults and never demands infra in test mode", () => {
    const env = loadWorkerEnv({ NODE_ENV: "test", PORT: "3101" });
    expect(env.PORT).toBe(3101);
    expect(env.SHOPIFY_API_VERSION).toBe("2025-10");
    expect(env.WORKER_CONCURRENCY).toBe(8);
  });

  it("refuses hosted environments without durable infrastructure", () => {
    expect(() =>
      loadWorkerEnv({ NODE_ENV: "production", PORT: "3100" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("accepts a complete production configuration", () => {
    const env = loadWorkerEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://prod",
      REDIS_URL: "redis://prod",
      ENCRYPTION_KEY: "prod-key",
      SHOPIFY_APP_URL: "https://app.example.com",
    });
    expect(env.REDIS_URL).toBe("redis://prod");
  });

  it("rejects invalid numeric bounds with a readable message", () => {
    expect(() => loadWorkerEnv({ WORKER_CONCURRENCY: "0" })).toThrow(/WORKER_CONCURRENCY/);
  });
});
