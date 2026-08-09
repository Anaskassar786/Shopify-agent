import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      // The pure contract modules are unit-tested here to ~100%. The
      // DB-coupled modules (writers/runner/analytics/webhook handlers/modules)
      // are verified end-to-end by the worker and API integration suites,
      // which run the real migrations against PGlite — same include-scoping
      // precedent as @profit/db's declarative schema files.
      include: ["src/dto.ts", "src/jobs.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
      reporter: ["text", "json-summary"],
    },
  },
});
