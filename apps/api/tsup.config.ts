import { defineConfig } from "tsup";

/**
 * Single-file ESM bundle for Railway deploys. Workspace packages are inlined
 * (noExternal) — the artifacts must run with zero workspace resolution.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: ["@profit/types", "@profit/db"],
  sourcemap: true,
  clean: true,
});
