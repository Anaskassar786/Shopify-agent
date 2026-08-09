import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ShopifyWebhookTopic } from "@profit/types";
import { WEBHOOK_REGISTRY } from "../modules/shopify/webhooks/registry";
import {
  APP_MANIFEST_HANDLE,
  APP_MANIFEST_NAME,
  CANONICAL_SCOPES,
  buildShopifyAppManifest,
  renderShopifyAppToml,
} from "./app-manifest";

const INPUT = {
  appUrl: "https://profit.example.com/",
  scopes: CANONICAL_SCOPES.join(","),
  apiVersion: "2025-10",
} as const;

describe("buildShopifyAppManifest (ADR 30 — declarative parity with runtime truth)", () => {
  it("declares the embedded app identity and single intake surface", () => {
    const manifest = buildShopifyAppManifest(INPUT);
    expect(manifest.name).toBe(APP_MANIFEST_NAME);
    expect(manifest.handle).toBe(APP_MANIFEST_HANDLE);
    expect(manifest.applicationUrl).toBe("https://profit.example.com");
    expect(manifest.embedded).toBe(true);
    expect(manifest.redirectUrls).toEqual(["https://profit.example.com/shopify/callback"]);
    expect(manifest.webhookUri).toBe("https://profit.example.com/shopify/webhooks");
    expect(manifest.apiVersion).toBe("2025-10");
  });

  it("mirrors the webhook registry exactly — api topics, no mandatory leakage", () => {
    const manifest = buildShopifyAppManifest(INPUT);
    const apiTopics = WEBHOOK_REGISTRY.filter((entry) => entry.registration === "api").map(
      (entry) => entry.topic,
    );
    const mandatoryTopics = WEBHOOK_REGISTRY.filter(
      (entry) => entry.registration === "mandatory",
    ).map((entry) => entry.topic);
    expect(manifest.webhookTopics).toEqual(apiTopics);
    expect(manifest.complianceTopics).toEqual(mandatoryTopics);
    expect(manifest.webhookTopics).toContain(ShopifyWebhookTopic.AppUninstalled);
    expect(manifest.complianceTopics).toEqual([
      ShopifyWebhookTopic.CustomersDataRequest,
      ShopifyWebhookTopic.CustomersRedact,
      ShopifyWebhookTopic.ShopRedact,
    ]);
    // A mandatory topic must never appear in the business subscription block.
    expect(manifest.webhookTopics).not.toContain(ShopifyWebhookTopic.CustomersDataRequest);
  });

  it("rejects malformed base URLs and empty scope contracts", () => {
    expect(() => buildShopifyAppManifest({ ...INPUT, appUrl: "not-a-url" })).toThrow();
    expect(() =>
      buildShopifyAppManifest({ ...INPUT, appUrl: "https://profit.example.com/embedded" }),
    ).toThrow(/origin only/);
    expect(() => buildShopifyAppManifest({ ...INPUT, scopes: " , " })).toThrow(/at least one/);
  });
});

describe("canonical scope contract", () => {
  it("stays in lockstep with the operator-facing .env.example", () => {
    const example = readFileSync(path.resolve(process.cwd(), "../../.env.example"), "utf8");
    expect(example).toContain(`SHOPIFY_SCOPES=${CANONICAL_SCOPES.join(",")}`);
  });
});

describe("renderShopifyAppToml (deploy-time materialization)", () => {
  const toml = renderShopifyAppToml(buildShopifyAppManifest(INPUT));

  it("renders the CLI-managed configuration sections with every line well-formed", () => {
    expect(toml.startsWith("# GENERATED — do not edit by hand.\n")).toBe(true);
    expect(toml.endsWith("\n")).toBe(true);
    for (const line of toml.trimEnd().split("\n")) {
      const trimmed = line.trim();
      expect(
        trimmed === "" ||
          trimmed.startsWith("#") ||
          /^\[{2}[^\]]+\]{2}$/.test(trimmed) ||
          /^\[[^\]]+\]$/.test(trimmed) ||
          /^[a-z_]+ = (true|false|"([^"\\]|\\.)*"|\[.*\])$/.test(trimmed),
        `malformed TOML line: ${line}`,
      ).toBe(true);
    }
    expect(toml).toContain('name = "PROFIT TOOL AI"');
    expect(toml).toContain("embedded = true");
    expect(toml).toContain("[access_scopes]");
    expect(toml).toContain(`scopes = "${CANONICAL_SCOPES.join(",")}"`);
    expect(toml).toContain('api_version = "2025-10"');
    expect(toml).toContain('redirect_urls = ["https://profit.example.com/shopify/callback"]');
  });

  it("groups business and compliance subscriptions under one intake URI", () => {
    const blocks = toml.split("[[webhooks.subscriptions]]").slice(1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("topics = [");
    expect(blocks[0]).toContain(`"${ShopifyWebhookTopic.OrdersCreate}"`);
    expect(blocks[1]).toContain("compliance_topics = [");
    expect(blocks[1]).toContain(`"${ShopifyWebhookTopic.ShopRedact}"`);
    for (const block of blocks) {
      expect(block).toContain('uri = "https://profit.example.com/shopify/webhooks"');
    }
  });

  it("renders deterministically and escapes string values", () => {
    const manifest = buildShopifyAppManifest(INPUT);
    expect(renderShopifyAppToml(manifest)).toBe(toml);
    const quoted = buildShopifyAppManifest({
      appUrl: "https://profit.example.com",
      scopes: 'read_products,"odd"',
      apiVersion: "2025-10",
    });
    expect(renderShopifyAppToml(quoted)).toContain('\\"odd\\"');
  });
});
