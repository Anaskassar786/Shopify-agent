import { eq } from "@profit/db";
import { webhookLogs } from "@profit/db";
import { WebhookStatus } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestEnvironment,
  shopifyWebhookHeaders,
  signOauthCallback,
  stubShopifyHttp,
  TEST_SHOP,
  API_SECRET,
  type TestEnvironment,
} from "../../../test-support/harness";
import request from "supertest";
import { AuditService } from "../../audit/audit.service";
import { ShopifyWebhookService } from "./webhook.service";

/**
 * Producer-side intake edge branches that the HTTP suite cannot reach through
 * the composed app (the composition root always wires the durable producer):
 * durable-without-producer fallback, unknown topics, malformed payloads.
 */

let env: TestEnvironment;

beforeAll(async () => {
  env = await buildTestEnvironment();
  stubShopifyHttp();
  const installRes = await request(env.app).get(`/shopify/install?shop=${TEST_SHOP}`).expect(302);
  const state = new URL(installRes.headers["location"] as string).searchParams.get("state") as string;
  await request(env.app)
    .get("/shopify/callback")
    .query(signOauthCallback({ code: "c-wh", shop: TEST_SHOP, state, timestamp: String(Date.now() / 1000 | 0) }))
    .expect(302);
});

afterAll(async () => {
  await env.close();
});

function intakeFor(topic: string, deliveryId: string, payload: unknown) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    shopDomainHeader: TEST_SHOP,
    topicHeader: topic,
    webhookIdHeader: deliveryId,
    hmacHeader: shopifyWebhookHeaders(TEST_SHOP, topic, deliveryId, raw)["x-shopify-hmac-sha256"],
    rawBody: raw,
  };
}

describe("ShopifyWebhookService — edges", () => {
  it("durable topics without a producer: intake degrades to safe ack (no silent data loss)", async () => {
    const service = new ShopifyWebhookService({
      db: env.db,
      audit: new AuditService(env.db, env.logger),
      logger: env.logger,
      apiSecret: API_SECRET,
      // no enqueueWebhookProcess — the degraded path
    });
    const outcome = await service.process(
      intakeFor("products/create", "svc-durable-fallback", { id: 991, title: "X" }),
    );
    expect(outcome.outcome).toBe("processed");
    const rows = await env.db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.shopifyWebhookId, "svc-durable-fallback"));
    // No producer: effect cannot be scheduled; row closes as PROCESSED and the
    // condition was logged (ops alert path) — never a silent hang in RECEIVED.
    expect(rows[0]?.status).toBe(WebhookStatus.Processed);
  });

  it("unknown topics are acknowledged and closed as processed", async () => {
    const outcome = await env.settle().then(() =>
      new ShopifyWebhookService({
        db: env.db,
        audit: new AuditService(env.db, env.logger),
        logger: env.logger,
        apiSecret: API_SECRET,
      }).process(intakeFor("fulfillments/create", "svc-unknown-topic", { id: 1 })),
    );
    expect(outcome.outcome).toBe("processed");
    const rows = await env.db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.shopifyWebhookId, "svc-unknown-topic"));
    expect(rows[0]?.status).toBe(WebhookStatus.Processed);
  });

  it("malformed payload JSON is a 400-class validation error, stored nothing", async () => {
    const service = new ShopifyWebhookService({
      db: env.db,
      audit: new AuditService(env.db, env.logger),
      logger: env.logger,
      apiSecret: API_SECRET,
    });
    const raw = Buffer.from("[1,2,3]", "utf8");
    await expect(
      service.process({
        shopDomainHeader: TEST_SHOP,
        topicHeader: "products/create",
        webhookIdHeader: "svc-bad-json",
        hmacHeader: shopifyWebhookHeaders(TEST_SHOP, "products/create", "svc-bad-json", raw)["x-shopify-hmac-sha256"],
        rawBody: raw,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("missing headers are rejected before any signature work", async () => {
    const service = new ShopifyWebhookService({
      db: env.db,
      audit: new AuditService(env.db, env.logger),
      logger: env.logger,
      apiSecret: API_SECRET,
    });
    await expect(
      service.process({
        shopDomainHeader: undefined,
        topicHeader: undefined,
        webhookIdHeader: undefined,
        hmacHeader: undefined,
        rawBody: Buffer.from("{}", "utf8"),
      }),
    ).rejects.toThrow(/missing Shopify webhook headers/);
  });
});
