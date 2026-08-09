import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  clean: true,
  sourcemap: true,
  noExternal: [
    "@profit/types",
    "@profit/db",
    "@profit/cache",
    "@profit/crypto",
    "@profit/logger",
    "@profit/queue",
    "@profit/shopify",
    "@profit/sync",
  ],
});
