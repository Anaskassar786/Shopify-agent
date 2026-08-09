import { defineConfig } from "tsup";

/**
 * Production ESM bundle for the API service on Railway.
 *
 * Strategy:
 *  - The artifact must run with zero workspace resolution (no pnpm symlinks,
 *    no `node_modules` traversal), so every workspace package the API reaches
 *    is bundled in via `noExternal`.
 *  - `skipNodeModulesBundle` keeps all of `node_modules` external. This is
 *    critical for CJS packages that must NOT be ESM-rewritten: `ioredis`,
 *    `bullmq`, and their native/optional-dependency graph. Bundling them
 *    breaks dynamic require / native resolution at runtime.
 *  - `external` re-affirms the npm runtime deps explicitly so the artifact's
 *    import map is unambiguous in logs and to make the CJS-bundling carve-out
 *    intentional rather than implicit.
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
  // All @profit/* packages must be inlined — Railway has no access to the
  // workspace and the artifact is a single self-contained JS file.
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
  // Keep npm dependencies external (resolved at runtime from node_modules).
  // These four MUST stay external — they are CJS with native/optional deps
  // that ESM bundling would break (ioredis, bullmq, pg-driver chain, mailer
  // transport stream).
  external: [
    "bullmq",
    "ioredis",
    "nodemailer",
    "postgres",
  ],
  skipNodeModulesBundle: true,
});
