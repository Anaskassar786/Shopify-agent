import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      /**
       * Coverage gate (P6: 80%+). M0 scope: pure contract modules with unit
       * tests. Express wiring (app.ts, middleware glue, routers) is covered by
       * integration tests from M1 — the gate list widens each milestone.
       */
      include: ["src/config/**", "src/lib/**", "src/modules/health/health.service.ts"],
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
