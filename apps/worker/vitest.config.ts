import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      /**
       * Handlers + config + health are the worker's executable surface; the
       * composition root (server.ts/index.ts) is verified by the integration
       * suite running through registerWorkerJobs exactly as it wires.
       */
      include: ["src/config/**", "src/handlers/**", "src/health/**"],
      // deps.ts is a pure type declaration (no runtime code to cover).
      exclude: ["src/**/*.test.ts", "src/test-support/**", "src/handlers/deps.ts"],
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
