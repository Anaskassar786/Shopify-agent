import { describe, expect, it } from "vitest";
import { Environment } from "@profit/types";
import { EnvValidationError, loadEnv, requireEnv } from "./env";

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "development", ...overrides };
}

describe("loadEnv", () => {
  it("applies safe defaults in development", () => {
    const env = loadEnv(baseEnv());
    expect(env.NODE_ENV).toBe(Environment.Development);
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AI_DEFAULT_GEMINI_MODEL).toBe("gemini-2.0-flash");
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => loadEnv({ NODE_ENV: "bogus" })).toThrow(EnvValidationError);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv(baseEnv({ PORT: "not-a-port" }))).toThrow(EnvValidationError);
  });

  it("requires critical secrets in production", () => {
    try {
      loadEnv({ NODE_ENV: "production" });
      expect.unreachable("production without secrets must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues.join("\n");
      expect(issues).toContain("DATABASE_URL");
      expect(issues).toContain("REDIS_URL");
      expect(issues).toContain("JWT_SECRET");
      expect(issues).toContain("SHOPIFY_API_KEY");
      expect(issues).toContain("ENCRYPTION_KEY");
    }
  });

  it("accepts a complete production configuration", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://prod",
      REDIS_URL: "redis://prod",
      JWT_SECRET: "a-jwt-secret",
      JWT_REFRESH_SECRET: "a-refresh-secret",
      ENCRYPTION_KEY: "an-encryption-key",
      SHOPIFY_API_KEY: "shp_key",
      SHOPIFY_API_SECRET: "shp_secret",
      SHOPIFY_APP_URL: "https://app.example.com",
      SHOPIFY_SCOPES: "read_products",
    });
    expect(env.NODE_ENV).toBe(Environment.Production);
    expect(env.SHOPIFY_APP_URL).toBe("https://app.example.com");
  });

  it("staging follows the same requirements as production", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow(EnvValidationError);
  });
});

describe("requireEnv", () => {
  it("returns the value when configured", () => {
    const env = loadEnv(baseEnv({ DATABASE_URL: "postgres://local" }));
    expect(requireEnv(env, "DATABASE_URL")).toBe("postgres://local");
  });

  it("throws named error when missing", () => {
    const env = loadEnv(baseEnv());
    expect(() => requireEnv(env, "GEMINI_API_KEY")).toThrow(EnvValidationError);
  });
});
