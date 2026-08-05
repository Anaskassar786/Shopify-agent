import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      /**
       * The schema files are declarative table definitions — they are verified
       * structurally by drizzle-kit generate + the integration suites, so line
       * coverage is measured on the executable layer only.
       */
      include: ["src/client.ts", "src/scope.ts", "src/seed.ts", "src/testing.ts"],
      exclude: ["src/**/*.test.ts", "src/bin/**"],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 70,
      },
      reporter: ["text", "json-summary"],
    },
  },
});
