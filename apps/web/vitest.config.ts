import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test-support/setup.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/test-support/**",
        "src/main.tsx",
        "src/styles.css",
        "src/types/**",
      ],
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
