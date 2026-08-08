import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildShopifyAppManifest,
  renderShopifyAppToml,
} from "../config/app-manifest";
import { loadEnv, requireEnv } from "../config/env";

/**
 * Deploy-time materialization of `shopify.app.toml` (ADR 30). Usage:
 *
 *   APP_URL=https://<prod-host> pnpm --filter @profit/api run manifest:render -- --out ../../shopify.app.toml
 *
 * The Partner Dashboard credentials are bound at deploy time via
 * `shopify app deploy --client-id <app>`; nothing secret is written here.
 */
function resolveOutPath(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--out");
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write("usage: tsx src/bin/render-manifest.ts --out <path>\n");
    process.exit(64);
  }
  return path.resolve(process.cwd(), value);
}

const env = loadEnv();
const appScopeSource = env.SHOPIFY_SCOPES;
if (appScopeSource === undefined) {
  process.stderr.write("SHOPIFY_SCOPES is required to render the manifest\n");
  process.exit(65);
}

const manifest = buildShopifyAppManifest({
  appUrl: requireEnv(env, "APP_URL"),
  scopes: appScopeSource,
  apiVersion: env.SHOPIFY_API_VERSION,
});
const toml = renderShopifyAppToml(manifest);
const outPath = resolveOutPath(process.argv.slice(2));
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, toml, "utf8");
process.stdout.write(`shopify.app.toml rendered → ${outPath}\n`);
