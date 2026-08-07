import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/test-support/**"],
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
