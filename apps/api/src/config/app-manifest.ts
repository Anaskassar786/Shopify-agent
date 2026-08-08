import { WEBHOOK_REGISTRY } from "../modules/shopify/webhooks/registry";

/**
 * Shopify managed-configuration manifest (ADR 30). The CLI's declarative
 * surface (scopes, redirect URLs, webhook subscriptions, API version) must
 * never drift from the runtime truth, so this module DERIVES the manifest
 * from the single sources of truth: the scope contract documented in
 * `.env.example`, the webhook registry in code, and the env-driven API
 * version. `pnpm --filter @profit/api run manifest:render` materializes
 * `shopify.app.toml` at deploy time for the target APP_URL — nothing
 * host-specific or credential-bearing is ever committed.
 */

/** Canonical OAuth scope contract — kept in parity with `.env.example` by test. */
export const CANONICAL_SCOPES: readonly string[] = [
  "read_products",
  "write_products",
  "read_orders",
  "read_customers",
  "read_inventory",
  "write_discounts",
  "read_price_rules",
  "read_draft_orders",
  "write_draft_orders",
  "read_fulfillments",
  "read_locations",
  "read_content",
];

export const APP_MANIFEST_NAME = "PROFIT TOOL AI";
export const APP_MANIFEST_HANDLE = "profit-tool-ai";
export const WEBHOOK_INTAKE_PATH = "/shopify/webhooks";
export const OAUTH_CALLBACK_PATH = "/shopify/callback";

export interface AppManifestInput {
  /** Public HTTPS base URL of the deployed app (no trailing slash needed). */
  readonly appUrl: string;
  /** Comma-separated OAuth scopes (Env.SHOPIFY_SCOPES). */
  readonly scopes: string;
  /** Shopify Admin API version (Env.SHOPIFY_API_VERSION). */
  readonly apiVersion: string;
}

export interface ShopifyAppManifest {
  readonly name: string;
  readonly handle: string;
  readonly applicationUrl: string;
  readonly embedded: true;
  readonly scopes: readonly string[];
  readonly redirectUrls: readonly string[];
  readonly apiVersion: string;
  /** Business + lifecycle topics registered via the managed config. */
  readonly webhookTopics: readonly string[];
  /** GDPR mandatory topics (delivered through compliance configuration). */
  readonly complianceTopics: readonly string[];
  /** Single intake URI all subscriptions point at. */
  readonly webhookUri: string;
}

function normalizeBaseUrl(appUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    throw new Error(`APP_URL is not a valid absolute URL: ${appUrl}`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`APP_URL must be the origin only (no path), got: ${appUrl}`);
  }
  return parsed.origin;
}

function parseScopes(scopes: string): readonly string[] {
  return scopes
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

export function buildShopifyAppManifest(input: AppManifestInput): ShopifyAppManifest {
  const origin = normalizeBaseUrl(input.appUrl);
  const scopes = parseScopes(input.scopes);
  if (scopes.length === 0) {
    throw new Error("SHOPIFY_SCOPES must declare at least one access scope");
  }
  return {
    name: APP_MANIFEST_NAME,
    handle: APP_MANIFEST_HANDLE,
    applicationUrl: origin,
    embedded: true,
    scopes,
    redirectUrls: [`${origin}${OAUTH_CALLBACK_PATH}`],
    apiVersion: input.apiVersion,
    webhookTopics: WEBHOOK_REGISTRY.filter((entry) => entry.registration === "api").map(
      (entry) => entry.topic,
    ),
    complianceTopics: WEBHOOK_REGISTRY.filter((entry) => entry.registration === "mandatory").map(
      (entry) => entry.topic,
    ),
    webhookUri: `${origin}${WEBHOOK_INTAKE_PATH}`,
  };
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

export function renderShopifyAppToml(manifest: ShopifyAppManifest): string {
  const lines: string[] = [
    "# GENERATED — do not edit by hand.",
    "# Regenerate for the target host: pnpm --filter @profit/api run manifest:render",
    "# (binds the Partner Dashboard app at deploy: shopify app deploy --client-id <app>)",
    `name = ${tomlString(manifest.name)}`,
    `handle = ${tomlString(manifest.handle)}`,
    `application_url = ${tomlString(manifest.applicationUrl)}`,
    "embedded = true",
    "",
    "[access_scopes]",
    `scopes = ${tomlString(manifest.scopes.join(","))}`,
    "",
    "[auth]",
    `redirect_urls = ${tomlStringArray(manifest.redirectUrls)}`,
    "",
    "[webhooks]",
    `api_version = ${tomlString(manifest.apiVersion)}`,
    "",
    "  [[webhooks.subscriptions]]",
    `  topics = ${tomlStringArray(manifest.webhookTopics)}`,
    `  uri = ${tomlString(manifest.webhookUri)}`,
    "",
    "  [[webhooks.subscriptions]]",
    `  compliance_topics = ${tomlStringArray(manifest.complianceTopics)}`,
    `  uri = ${tomlString(manifest.webhookUri)}`,
  ];
  return `${lines.join("\n")}\n`;
}
