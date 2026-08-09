import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      /**
       * Coverage gate (P6: 80%+). M1 scope: all first-party modules — including
       * middleware and routers, which the supertest+PGlite integration suite
       * exercises end-to-end. Excluded: composition/entry (server.ts, index.ts,
       * app.ts) and the test harness itself.
       */
      include: [
        "src/config/**",
        "src/lib/**",
        "src/middleware/**",
        "src/modules/**",
        "src/routes/**",
      ],
      exclude: ["src/**/*.test.ts", "src/test-support/**"],
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
