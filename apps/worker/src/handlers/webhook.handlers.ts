import { eq } from "@profit/db";
import { stores, webhookLogs } from "@profit/db";
import { CacheInvalidator } from "@profit/cache";
import { WebhookStatus } from "@profit/types";
import type { JobHandler } from "@profit/queue";
import {
  AnalyticsRefreshJob,
  applierForTopic,
  resolveStoreAdminContext,
  windowForDates,
  type WebhookProcessPayload,
} from "@profit/sync";
import { recordWorkerAudit } from "./audit";
import type { WorkerDeps } from "./deps";

/**
 * webhook.process — the durable second half of the intake pipeline (P2).
 * The API has already verified HMAC and persisted the delivery; this handler
 * applies the business effect, then:
 *   - transitions the webhook_logs row RECEIVED → PROCESSED (or FAILED after
 *     final attempt — retries stay RECEIVED so the state machine is honest);
 *   - bumps the reported cache domains;
 *   - enqueues a date-windowed analytics refresh when the payload moved money.
 * Unknown topics (registered but not yet consumed) are marked PROCESSED —
 * they were acked by design at intake time.
 */
export function webhookProcessHandler(deps: WorkerDeps): JobHandler<WebhookProcessPayload> {
  return async (ctx) => {
    const { storeId, webhookLogId } = ctx.payload;
    const rows = await deps.db.db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.id, webhookLogId))
      .limit(1);
    const logRow = rows[0];
    if (logRow === undefined) {
      deps.logger.error({ webhookLogId, storeId }, "webhook.process.log_missing");
      return; // Dead-end the job: nothing durable to act on.
    }
    if (logRow.storeId !== storeId) {
      deps.logger.error({ webhookLogId }, "webhook.process.tenant_mismatch");
      return;
    }
    if (logRow.status !== WebhookStatus.Received) {
      // Already handled (or platform-handled inline): replay is a safe no-op.
      return;
    }

    const applier = applierForTopic(logRow.topic);
    if (applier === null) {
      await deps.db.db
        .update(webhookLogs)
        .set({ status: WebhookStatus.Processed, processedAt: new Date(), updatedAt: new Date() })
        .where(eq(webhookLogs.id, webhookLogId));
      return;
    }

    const storeRows = await deps.db.db
      .select({ shopDomain: stores.shopDomain })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const shopDomain = storeRows[0]?.shopDomain;
    if (shopDomain === undefined) {
      throw new Error(`webhook.process: store ${storeId} vanished mid-processing`);
    }

    const admin = await resolveStoreAdminContext(deps.db.db, deps.encryption, storeId);

    try {
      const result = await applier({
        db: deps.db.db,
        storeId,
        shopDomain,
        payload: logRow.payload as Record<string, unknown>,
        admin: { ...admin, apiVersion: deps.env.SHOPIFY_API_VERSION },
      });

      await deps.db.db
        .update(webhookLogs)
        .set({ status: WebhookStatus.Processed, processedAt: new Date(), updatedAt: new Date() })
        .where(eq(webhookLogs.id, webhookLogId));

      if (result.invalidate.length > 0) {
        await new CacheInvalidator(deps.cache, deps.logger).bumpAll(storeId, result.invalidate);
      }
      if (result.analyticsDates.length > 0) {
        const window = windowForDates(result.analyticsDates);
        await deps.persistence.enqueuePersistent(
          deps.queue,
          AnalyticsRefreshJob,
          {
            storeId,
            ...(window.kind === "range"
              ? { dateFrom: window.dateFrom, dateTo: window.dateTo }
              : {}),
          },
          { jobId: `analytics:webhook:${webhookLogId}` },
        );
      }

      await recordWorkerAudit(deps.db.db, deps.logger, {
        storeId,
        action: "shopify.webhook.processed",
        entityType: "webhook",
        entityId: webhookLogId,
        result: "SUCCESS",
        metadata: { topic: logRow.topic, analyticsDates: result.analyticsDates },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finalAttempt = ctx.attempt >= ctx.maxAttempts;
      await deps.db.db
        .update(webhookLogs)
        .set({
          status: finalAttempt ? WebhookStatus.Failed : WebhookStatus.Received,
          errorMessage: message,
          updatedAt: new Date(),
          ...(finalAttempt ? { processedAt: new Date() } : {}),
        })
        .where(eq(webhookLogs.id, webhookLogId));
      if (finalAttempt) {
        await recordWorkerAudit(deps.db.db, deps.logger, {
          storeId,
          action: "shopify.webhook.process_failed",
          entityType: "webhook",
          entityId: webhookLogId,
          result: "FAILURE",
          metadata: { topic: logRow.topic, error: message, attempts: ctx.attempt },
        });
      }
      throw error; // queue retries per the job definition
    }
  };
}
