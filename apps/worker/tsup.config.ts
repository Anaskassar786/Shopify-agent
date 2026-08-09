import { defineConfig } from "tsup";

/**
 * Production ESM bundle for the worker service on Railway.
 *
 * Strategy mirrors apps/api/tsup.config.ts:
 *  - All workspace packages in the worker's transitive @profit/* closure are
 *    bundled in via `noExternal` so the artifact has zero workspace
 *    resolution. The worker doesn't import @profit/forecasting directly,
 *    but @profit/ai and @profit/reporting pull it in, so it is in the
 *    closure and must be noExternal.
 *  - All npm dependencies stay external and `skipNodeModulesBundle` keeps the
 *    CJS/optional-deps graph (bullmq, ioredis, postgres) intact.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [
    "@profit/ai",
    "@profit/automation",
    "@profit/billing",
    "@profit/cache",
    "@profit/crypto",
    "@profit/db",
    "@profit/forecasting",
    "@profit/logger",
    "@profit/monitoring",
    "@profit/notifications",
    "@profit/queue",
    "@profit/reporting",
    "@profit/shopify",
    "@profit/sync",
    "@profit/types",
  ],
  external: [
    "bullmq",
    "ioredis",
    "nodemailer",
    "postgres",
  ],
  skipNodeModulesBundle: true,
});
