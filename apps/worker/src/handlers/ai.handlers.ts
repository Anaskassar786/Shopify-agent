import { eq } from "@profit/db";
import { stores } from "@profit/db";
import {
  ActionType,
  AiRunTrigger,
  EngagementEventKind,
  NotificationCategory,
  RealtimeEventKind,
  StoreStatus,
  type RealtimeEvent,
} from "@profit/types";
import { BillingService, EngagementService } from "@profit/billing";
import type { JobHandler } from "@profit/queue";
import {
  AiExecuteDiscountActionJob,
  AiExecuteEmailActionJob,
  AiRunJob,
  AttributionService,
  DecisionService,
  type AiRunPayload,
  type RunNotifier,
  type RunSummary,
} from "@profit/ai";
import { NotificationService, channelFor } from "@profit/notifications";
import { recordWorkerAudit } from "./audit";
import { publishRealtime } from "./realtime";
import type { WorkerDeps } from "./deps";

/**
 * AI plane handlers (M4). The composition root wires:
 *   ai.nightly-tick  → per-store ai.run fan-out (scheduled trigger)
 *   ai.run           → DecisionService.run (context → rules → agents → persist)
 *   ai.measure-tick  → attribution sweep + expiry for every active store
 *
 * After every run, auto-approved executions are enqueued onto their tool
 * queues (email/discount) with the execution id as the idempotency key —
 * BullMQ dedupe makes re-runs of the tick physically safe.
 */

function buildNotifier(deps: WorkerDeps): RunNotifier {
  const notifications = new NotificationService(deps.db.db, deps.pubsub);
  return {
    notify: async (storeId, input) => {
      await notifications.create(storeId, {
        category: input.category,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
      });
    },
    publish: async (storeId, event) => {
      await deps.pubsub.publish(channelFor(storeId), event as unknown as RealtimeEvent);
    },
  };
}

async function enqueueExecutions(deps: WorkerDeps, summary: RunSummary, storeId: string): Promise<void> {
  for (const execution of summary.executionsToEnqueue) {
    const job =
      execution.actionType === ActionType.SendRecoveryEmail
        ? AiExecuteEmailActionJob
        : AiExecuteDiscountActionJob;
    await deps.persistence.enqueuePersistent(
      deps.queue,
      job,
      {
        storeId,
        recommendationId: execution.recommendationId,
        executionId: execution.executionId,
      },
      { jobId: `aiexec:${execution.executionId}` },
    );
  }
}

export function aiRunHandler(deps: WorkerDeps): JobHandler<AiRunPayload> {
  return async (ctx) => {
    const { storeId, trigger, requestedByUserId } = ctx.payload;
    const service = new DecisionService({
      db: deps.db.db,
      logger: deps.logger,
      provider: deps.aiProvider,
      notifier: buildNotifier(deps),
      maxAgentCallsPerRun: deps.env.AI_MAX_AGENT_CALLS_PER_RUN,
    });
    const summary = await service.run(storeId, trigger);
    await enqueueExecutions(deps, summary, storeId);

    // M5 activation funnel step 3 (deduped; telemetry never breaks the run).
    if (summary.status === "COMPLETED") {
      try {
        await new EngagementService(deps.db.db).emit({
          storeId,
          kind: EngagementEventKind.FirstAiRunCompleted,
        });
      } catch (emitError) {
        deps.logger.warn({ err: emitError, storeId }, "engagement.first_ai_run_completed.failed");
      }
    }

    for (const created of summary.created) {
      await publishRealtime(deps.pubsub, {
        kind: RealtimeEventKind.RecommendationCreated,
        storeId,
        occurredAt: new Date().toISOString(),
        payload: {
          recommendationId: created.id,
          type: created.type,
          title: created.title,
          priority: created.priority,
        },
      });
    }

    await recordWorkerAudit(deps.db.db, deps.logger, {
      storeId,
      action: "ai.run.completed",
      entityType: "ai_run",
      ...(summary.runId !== null ? { entityId: summary.runId } : {}),
      result: summary.status === "FAILED" ? "FAILURE" : "SUCCESS",
      metadata: {
        trigger,
        ...(trigger === AiRunTrigger.Manual && requestedByUserId !== undefined
          ? { requestedByUserId }
          : {}),
        status: summary.status,
        healthScore: summary.health.score,
        firings: summary.firings,
        agentCalls: summary.agentCalls,
        created: summary.created.length,
        duplicatesSkipped: summary.duplicatesSkipped,
      },
    });
    deps.logger.info(
      { storeId, runId: summary.runId, status: summary.status, created: summary.created.length },
      "ai.run.handler.completed",
    );
  };
}

export function aiNightlyTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    // 6h bucket identity (matches AI_SCHEDULES.runEveryMs cadence).
    const bucket = Math.floor(Date.now() / (6 * 60 * 60_000));
    const activeStores = await deps.db.db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.status, StoreStatus.Active));
    const billing = new BillingService(deps.db.db);
    let skippedByPlan = 0;
    for (const store of activeStores) {
      // M5 gate: scheduled model spend is a revenue action — an inactive plan
      // burns zero tokens (manual runs are gated at the API with a 403 CTA).
      const access = await billing.evaluateStoreAccess(store.id);
      if (!access.revenueActionsAllowed) {
        skippedByPlan += 1;
        continue;
      }
      await deps.persistence.enqueuePersistent(
        deps.queue,
        AiRunJob,
        { storeId: store.id, trigger: AiRunTrigger.Scheduled },
        { jobId: `ai:run:${bucket}:${store.id}` },
      );
    }
    deps.logger.info(
      { stores: activeStores.length - skippedByPlan, bucket, skippedByPlan },
      "ai.nightly_tick.fanned_out",
    );
  };
}

export function aiMeasureTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const activeStores = await deps.db.db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.status, StoreStatus.Active));
    const attribution = new AttributionService(deps.db.db);
    let measured = 0;
    let expired = 0;
    for (const store of activeStores) {
      const summary = await attribution.measureStore(store.id);
      measured += summary.measured;
      expired += summary.expired;
    }
    deps.logger.info({ stores: activeStores.length, measured, expired }, "ai.measure_tick.completed");
  };
}

/** Shared for both execute handlers: what to do when the executor gave up. */
export async function notifyExecutionFailed(
  deps: WorkerDeps,
  input: {
    storeId: string;
    recommendationId: string;
    type: string;
    actionType: string;
    errorMessage: string | null;
  },
): Promise<void> {
  const notifications = new NotificationService(deps.db.db, deps.pubsub);
  await notifications.create(input.storeId, {
    category: NotificationCategory.Automation,
    title: "An automation action failed",
    body: `The approved action could not be completed after all retries: ${input.errorMessage ?? "unknown error"}. Review it on the Recommendations page — nothing else was executed.`,
    actionUrl: `/recommendations/${input.recommendationId}`,
  });
  await publishRealtime(deps.pubsub, {
    kind: RealtimeEventKind.RecommendationExecuted,
    storeId: input.storeId,
    occurredAt: new Date().toISOString(),
    payload: {
      recommendationId: input.recommendationId,
      type: input.type,
      actionType: input.actionType,
      succeeded: false,
    },
  });
}
