import { eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { stores, webhookLogs } from "@profit/db";
import { WebhookStatus } from "@profit/types";
import { AuthenticationError, ValidationError } from "../../../lib/errors";
import type { Logger } from "@profit/logger";
import { verifyWebhookHmac } from "@profit/shopify";
import { isShopDomain } from "@profit/shopify";
import type { AuditService } from "../../audit/audit.service";
import { lookupTopic } from "./registry";

/**
 * Webhook intake (P2 pipeline, verbatim): validate HMAC → verify store → store
 * event → update database → audit → return success. Dedup is physical: the
 * (store, topic, delivery) unique constraint makes Shopify at-least-once
 * delivery idempotent (P12: duplicate prevention).
 *
 * Handler failures are recorded (FAILED row + audit) and the delivery is still
 * acknowledged: Shopify retries on non-2xx and a poison payload would loop
 * forever. Replay tooling over FAILED rows ships with the M2 sync engine.
 */

export interface WebhookIntake {
  readonly shopDomainHeader: string | undefined;
  readonly topicHeader: string | undefined;
  readonly webhookIdHeader: string | undefined;
  readonly hmacHeader: string | undefined;
  readonly rawBody: Buffer;
  readonly ip?: string | undefined;
}

export interface WebhookOutcome {
  readonly outcome: "processed" | "duplicate" | "ignored-unknown-store" | "failed";
  readonly topic: string;
}

export interface WebhookServiceDeps {
  readonly db: ProfitDb;
  readonly audit: AuditService;
  readonly logger: Logger;
  readonly apiSecret: string;
  /**
   * Durable handoff for business topics (M2 data plane): intake enqueues the
   * worker-side "webhook.process" job instead of processing inline. Platform /
   * compliance topics always stay inline regardless of this hook's presence.
   */
  readonly enqueueWebhookProcess?: ((storeId: string, webhookLogId: string) => Promise<void>) | undefined;
}

export class ShopifyWebhookService {
  constructor(private readonly deps: WebhookServiceDeps) {}

  async process(intake: WebhookIntake): Promise<WebhookOutcome> {
    const { db, audit, logger, apiSecret } = this.deps;
    const { shopDomainHeader, topicHeader, webhookIdHeader, hmacHeader, rawBody } = intake;

    if (
      shopDomainHeader === undefined ||
      topicHeader === undefined ||
      webhookIdHeader === undefined ||
      hmacHeader === undefined
    ) {
      throw new ValidationError("missing Shopify webhook headers");
    }
    if (!isShopDomain(shopDomainHeader)) {
      throw new ValidationError("invalid shop domain in webhook headers");
    }
    if (!verifyWebhookHmac(rawBody, hmacHeader, apiSecret)) {
      logger.warn({ shop: shopDomainHeader, topic: topicHeader }, "webhook.hmac_rejected");
      await audit.record({
        action: "shopify.webhook.hmac_rejected",
        entityType: "webhook",
        result: "FAILURE",
        ...(intake.ip !== undefined ? { ip: intake.ip } : {}),
        metadata: { shopDomain: shopDomainHeader, topic: topicHeader },
      });
      throw new AuthenticationError("webhook signature verification failed");
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("payload must be a JSON object");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new ValidationError("webhook payload is not valid JSON");
    }

    const storeRows = await db
      .select()
      .from(stores)
      .where(eq(stores.shopDomain, shopDomainHeader))
      .limit(1);
    const store = storeRows[0];
    if (store === undefined) {
      // Unknown store: acknowledge to stop Shopify retries (their back-off would
      // amplify), and record enough for ops to investigate.
      logger.warn({ shop: shopDomainHeader, topic: topicHeader }, "webhook.unknown_store");
      await audit.record({
        action: "shopify.webhook.unknown_store",
        entityType: "webhook",
        result: "FAILURE",
        metadata: { shopDomain: shopDomainHeader, topic: topicHeader },
      });
      return { outcome: "ignored-unknown-store", topic: topicHeader };
    }

    const inserted = await db
      .insert(webhookLogs)
      .values({
        storeId: store.id,
        topic: topicHeader,
        shopifyWebhookId: webhookIdHeader,
        payload,
        hmacValid: true,
        status: WebhookStatus.Received,
      })
      .onConflictDoNothing({
        target: [
          webhookLogs.storeId,
          webhookLogs.topic,
          webhookLogs.shopifyWebhookId,
        ],
      })
      .returning({ id: webhookLogs.id });

    const logRow = inserted[0];
    if (logRow === undefined) {
      return { outcome: "duplicate", topic: topicHeader };
    }

    const { entry, inlineHandler, durable } = lookupTopic(topicHeader);

    // Durable business delivery: the worker applies the effect with retries;
    // the RECEIVED row is the handoff receipt (M2 sync engine pipeline).
    if (durable && this.deps.enqueueWebhookProcess !== undefined) {
      await this.deps.enqueueWebhookProcess(store.id, logRow.id);
      return { outcome: "processed", topic: topicHeader };
    }
    if (durable) {
      logger.warn(
        { storeId: store.id, topic: topicHeader },
        "webhook.queue_unavailable_inline_fallback",
      );
    }

    if (entry === null || inlineHandler === null) {
      await db
        .update(webhookLogs)
        .set({ status: WebhookStatus.Processed, processedAt: new Date() })
        .where(eq(webhookLogs.id, logRow.id));
      return { outcome: "processed", topic: topicHeader };
    }

    try {
      await inlineHandler({
        db,
        audit,
        store: { id: store.id, shopDomain: store.shopDomain },
        payload,
      });
      await db
        .update(webhookLogs)
        .set({ status: WebhookStatus.Processed, processedAt: new Date() })
        .where(eq(webhookLogs.id, logRow.id));
      return { outcome: "processed", topic: topicHeader };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, storeId: store.id, topic: topicHeader }, "webhook.handler.failed");
      await db
        .update(webhookLogs)
        .set({ status: WebhookStatus.Failed, errorMessage: message, processedAt: new Date() })
        .where(eq(webhookLogs.id, logRow.id));
      await audit.record({
        storeId: store.id,
        action: "shopify.webhook.handler_failed",
        entityType: "webhook",
        entityId: logRow.id,
        result: "FAILURE",
        metadata: { topic: topicHeader, error: message },
      });
      return { outcome: "failed", topic: topicHeader };
    }
  }
}
