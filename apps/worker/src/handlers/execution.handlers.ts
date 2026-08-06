import { and, eq } from "@profit/db";
import { actionExecutions, recommendations, storeSettings, stores, withStoreScope } from "@profit/db";
import { ExecutionStatus, RecommendationStatus, RealtimeEventKind, UsageMeter } from "@profit/types";
import { BillingService } from "@profit/billing";
import type { JobHandler } from "@profit/queue";
import {
  executeAction,
  type AiExecuteActionPayload,
  type StoreBranding,
} from "@profit/ai";
import { resolveStoreAdminContext } from "@profit/sync";
import type { ShopifyAdminContext } from "@profit/shopify";
import { z } from "zod";
import { recordWorkerAudit } from "./audit";
import { notifyExecutionFailed } from "./ai.handlers";
import { publishRealtime } from "./realtime";
import type { WorkerDeps } from "./deps";

/**
 * ai.action.execute.* handlers (M4 tool workers). One handler factory serves
 * both queues (email/discount) — the payload and semantics are identical, the
 * queue split exists purely for P3-taxonomy isolation of tool failures.
 *
 * Retry semantics: the executor resumes from toolRef checkpoints, so a job
 * retry after a crash never double-creates a discount or double-sends an
 * email. On the FINAL failed attempt the handler flips the recommendation to
 * FAILED with its audit event and notifies the merchant (P3 failsafe).
 */

const brandingSchema = z.object({
  logoUrl: z.string().nullish(),
  primaryColor: z.string().nullish(),
});

async function loadBranding(deps: WorkerDeps, storeId: string): Promise<{ branding: StoreBranding; shopDomain: string } | null> {
  const rows = await deps.db.db
    .select({
      name: stores.name,
      email: stores.email,
      shopDomain: stores.shopDomain,
      branding: storeSettings.branding,
    })
    .from(stores)
    .leftJoin(storeSettings, eq(storeSettings.storeId, stores.id))
    .where(eq(stores.id, storeId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const parsed = brandingSchema.safeParse(row.branding ?? {});
  const raw = parsed.success ? parsed.data : {};
  return {
    shopDomain: row.shopDomain,
    branding: {
      storeName: row.name,
      logoUrl: raw.logoUrl ?? null,
      primaryColor: raw.primaryColor ?? null,
      supportEmail: row.email,
    },
  };
}

async function markRecommendationFailed(
  deps: WorkerDeps,
  input: { storeId: string; recommendationId: string; errorMessage: string | null },
): Promise<{ type: string; actionType: string } | null> {
  return withStoreScope(deps.db.db, input.storeId, async (tx) => {
    const rows = await tx
      .select()
      .from(recommendations)
      .where(
        and(
          eq(recommendations.id, input.recommendationId),
          eq(recommendations.storeId, input.storeId),
        ),
      )
      .limit(1);
    const rec = rows[0];
    if (rec === undefined) return null;
    // Only an in-flight recommendation can fail; terminal states stay put.
    if (
      rec.status !== RecommendationStatus.Approved &&
      rec.status !== RecommendationStatus.Executing &&
      rec.status !== RecommendationStatus.Failed
    ) {
      return { type: rec.type, actionType: rec.actionType };
    }
    await tx
      .update(recommendations)
      .set({
        status: RecommendationStatus.Failed,
        stateVersion: rec.stateVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(recommendations.id, rec.id));
    return { type: rec.type, actionType: rec.actionType };
  });
}

async function loadRecommendationInfo(
  deps: WorkerDeps,
  storeId: string,
  recommendationId: string,
): Promise<{ type: string; actionType: string } | null> {
  return withStoreScope(deps.db.db, storeId, async (tx) => {
    const rows = await tx
      .select({ type: recommendations.type, actionType: recommendations.actionType })
      .from(recommendations)
      .where(
        and(
          eq(recommendations.id, recommendationId),
          eq(recommendations.storeId, storeId),
        ),
      )
      .limit(1);
    const rec = rows[0];
    return rec === undefined ? null : { type: rec.type, actionType: rec.actionType };
  });
}

/**
 * M5 preflight for METERED side effects (email sends burn quota per
 * recipient): check the plan BEFORE the tool runs. A denial is terminal, not
 * retryable — the queue retrying cannot raise a quota; the merchant upgrades.
 * The execution row flips FAILED (never stranded PENDING), the recommendation
 * follows, the merchant is notified with the exact CTA copy.
 */
async function failExecutionEntitlementDenied(
  deps: WorkerDeps,
  input: { storeId: string; recommendationId: string; executionId: string; reason: string },
): Promise<void> {
  const { storeId, recommendationId, executionId, reason } = input;
  await withStoreScope(deps.db.db, storeId, async (tx) => {
    await tx
      .update(actionExecutions)
      .set({
        status: ExecutionStatus.Failed,
        errorMessage: reason,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(actionExecutions.id, executionId), eq(actionExecutions.storeId, storeId)));
  });
  const failed = await markRecommendationFailed(deps, { storeId, recommendationId, errorMessage: reason });
  await notifyExecutionFailed(deps, {
    storeId,
    recommendationId,
    type: failed?.type ?? "UNKNOWN",
    actionType: failed?.actionType ?? "UNKNOWN",
    errorMessage: reason,
  });
  await recordWorkerAudit(deps.db.db, deps.logger, {
    storeId,
    action: "ai.action.failed",
    entityType: "action_execution",
    entityId: executionId,
    result: "FAILURE",
    metadata: { recommendationId, reasonCode: "ENTITLEMENT_DENIED", error: reason },
  });
}

function makeExecuteActionHandler(deps: WorkerDeps, preflightMeter: UsageMeter | null): JobHandler<AiExecuteActionPayload> {
  return async (ctx) => {
    const { storeId, recommendationId, executionId } = ctx.payload;
    if (preflightMeter !== null) {
      const denied = await new BillingService(deps.db.db).checkEntitlement(storeId, preflightMeter);
      if (denied !== null) {
        deps.logger.warn(
          { storeId, executionId, meter: preflightMeter, reason: denied.reason },
          "ai.execute.entitlement_denied",
        );
        await failExecutionEntitlementDenied(deps, { storeId, recommendationId, executionId, reason: denied.message });
        return;
      }
    }
    const [resolved, recInfo] = await Promise.all([
      loadBranding(deps, storeId),
      loadRecommendationInfo(deps, storeId, recommendationId),
    ]);
    if (resolved === null) {
      throw new Error(`store ${storeId} missing during action execution`);
    }
    let admin: ShopifyAdminContext | null = null;
    try {
      const resolvedAdmin = await resolveStoreAdminContext(deps.db.db, deps.encryption, storeId);
      admin = { ...resolvedAdmin, apiVersion: deps.env.SHOPIFY_API_VERSION };
    } catch (error) {
      deps.logger.warn({ err: error, storeId }, "ai.execute.admin_context_unresolvable");
    }

    const outcome = await executeAction(
      {
        db: deps.db.db,
        admin,
        email: deps.emailSender,
        branding: resolved.branding,
        shopDomain: resolved.shopDomain,
      },
      { storeId, recommendationId, executionId },
    );

    if (outcome.status === "SUCCEEDED") {
      await publishRealtime(deps.pubsub, {
        kind: RealtimeEventKind.RecommendationExecuted,
        storeId,
        occurredAt: new Date().toISOString(),
        payload: {
          recommendationId,
          type: recInfo?.type ?? "UNKNOWN",
          actionType: recInfo?.actionType ?? "UNKNOWN",
          succeeded: true,
        },
      });
      await recordWorkerAudit(deps.db.db, deps.logger, {
        storeId,
        action: "ai.action.executed",
        entityType: "action_execution",
        entityId: executionId,
        result: "SUCCESS",
        metadata: { recommendationId },
      });
      return;
    }

    const finalAttempt = ctx.attempt >= ctx.maxAttempts;
    if (outcome.retryable && !finalAttempt) {
      // Let the queue retry — execution row already carries the typed error.
      throw new Error(outcome.errorMessage ?? "action execution failed (retryable)");
    }
    const failed = await markRecommendationFailed(deps, {
      storeId,
      recommendationId,
      errorMessage: outcome.errorMessage,
    });
    await notifyExecutionFailed(deps, {
      storeId,
      recommendationId,
      type: failed?.type ?? "UNKNOWN",
      actionType: failed?.actionType ?? "UNKNOWN",
      errorMessage: outcome.errorMessage,
    });
    await recordWorkerAudit(deps.db.db, deps.logger, {
      storeId,
      action: "ai.action.failed",
      entityType: "action_execution",
      entityId: executionId,
      result: "FAILURE",
      metadata: { recommendationId, attempts: ctx.attempt, error: outcome.errorMessage },
    });
  };
}

export const executeEmailActionHandler = (deps: WorkerDeps): JobHandler<AiExecuteActionPayload> =>
  makeExecuteActionHandler(deps, UsageMeter.EmailsSent);
export const executeDiscountActionHandler = (deps: WorkerDeps): JobHandler<AiExecuteActionPayload> =>
  makeExecuteActionHandler(deps, null);
