import { createHash } from "node:crypto";
import { and, eq, gte, inArray, or, sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  actionExecutions,
  aiCallLogs,
  aiRuns,
  recommendations,
  recommendationEvents,
  recommendationEvidence,
  withStoreScope,
} from "@profit/db";
import {
  ActionType,
  AiRunStatus,
  AiRunTrigger,
  EventActorType,
  ModelTier,
  NotificationCategory,
  RecommendationEventType,
  RecommendationStatus,
  type AiAgentId,
} from "@profit/types";
import type { Logger } from "@profit/logger";
import { buildBusinessContext } from "../context/builder";
import { computeStoreHealth, type StoreHealth } from "../context/health";
import type { BusinessContext } from "../context/types";
import { evaluateRules } from "../rules/catalog";
import {
  AGENT_RUN_ORDER,
  agentOutputSchema,
  buildUserMessage,
  promptSpecFor,
} from "../prompts/registry";
import { scoreDrafts, type ScoredDraft } from "../scoring";
import { AiProviderError, type AiProvider } from "../provider/port";

/**
 * Decision Service (P3/P10 pipeline orchestrator):
 *   context → rules → agents → calibration → dedupe → persist → autopilot.
 *
 * GUARANTEES
 *  - Provider-absent is a FIRST-CLASS outcome (P3 failsafe): the run lands as
 *    PROVIDER_UNAVAILABLE, the merchant is notified (≤1/day), nothing executes.
 *  - Every persisted recommendation carries its immutable evidence snapshot +
 *    CREATED event in one transaction — orphan states are impossible.
 *  - Idempotency: open-fingerprint partial-unique index + 30d reject memory
 *    make re-runs convergent; nothing stacks.
 *  - Autopilot (automation modes, P3) is guarded by merchant policy caps and
 *    calibrated confidence — FULLY_AUTOMATIC can never exceed them.
 */

export interface RunNotifier {
  notify(
    storeId: string,
    input: {
      category: NotificationCategory;
      title: string;
      body: string;
      actionUrl: string | null;
    },
  ): Promise<void>;
  publish(storeId: string, event: Record<string, unknown>): Promise<void>;
}

export interface DecisionServiceDeps {
  readonly db: ProfitDb;
  readonly logger: Logger;
  readonly provider: AiProvider | null;
  readonly notifier: RunNotifier;
  /** Hard cap on provider calls per run (P10 cost optimization). */
  readonly maxAgentCallsPerRun: number;
}

export interface CreatedRecommendation {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly priority: string;
}

export interface RunSummary {
  readonly runId: string | null;
  readonly status: (typeof AiRunStatus)[keyof typeof AiRunStatus];
  readonly health: StoreHealth;
  readonly firings: number;
  readonly agentCalls: number;
  readonly created: readonly CreatedRecommendation[];
  readonly duplicatesSkipped: number;
  /** Executions the caller must enqueue (autopilot path). */
  readonly executionsToEnqueue: readonly {
    readonly executionId: string;
    readonly recommendationId: string;
    readonly actionType: (typeof ActionType)[keyof typeof ActionType];
  }[];
  readonly errorMessage: string | null;
}

const REJECT_MEMORY_DAYS = 30;
const UNAVAILABLE_NOTICE_COOLDOWN_HOURS = 24;

function fingerprintOf(storeId: string, scored: ScoredDraft): string {
  return createHash("sha256")
    .update(`${storeId}|${scored.firing.ruleId}|v${scored.firing.ruleVersion}|${scored.firing.subjectKey}`)
    .digest("hex");
}

function requestDigestOf(agentId: AiAgentId, model: string, promptId: string, userMessage: string): string {
  return createHash("sha256").update(`${agentId}|${model}|${promptId}|${userMessage}`).digest("hex");
}

export class DecisionService {
  constructor(private readonly deps: DecisionServiceDeps) {}

  async run(
    storeId: string,
    trigger: (typeof AiRunTrigger)[keyof typeof AiRunTrigger],
  ): Promise<RunSummary> {
    const startedAt = new Date();
    const { db, logger } = this.deps;
    const ctx = await buildBusinessContext(db, storeId, startedAt);
    const health = computeStoreHealth(ctx);
    const firings = evaluateRules(ctx);

    if (this.deps.provider === null) {
      const runId = await this.writeRunRow(storeId, trigger, {
        status: AiRunStatus.ProviderUnavailable,
        health,
        agentsPlanned: AGENT_RUN_ORDER.length,
        agentsCompleted: 0,
        created: 0,
        duplicatesSkipped: 0,
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 },
        errorMessage: "AI provider not configured (GEMINI_API_KEY missing)",
        startedAt,
      });
      await this.notifyProviderUnavailable(storeId, trigger);
      logger.warn({ storeId, runId }, "ai.run.provider_unavailable");
      return {
        runId,
        status: AiRunStatus.ProviderUnavailable,
        health,
        firings: firings.length,
        agentCalls: 0,
        created: [],
        duplicatesSkipped: 0,
        executionsToEnqueue: [],
        errorMessage: "AI provider not configured",
      };
    }

    const provider = this.deps.provider;
    const usageAcc = { calls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 };
    const scoredAll: ScoredDraft[] = [];
    const callLogInserts: (typeof aiCallLogs.$inferInsert)[] = [];
    let agentsCompleted = 0;
    let partialError: string | null = null;
    let aborted = false;

    for (const agentId of AGENT_RUN_ORDER) {
      if (aborted || usageAcc.calls >= this.deps.maxAgentCallsPerRun) break;
      const agentFirings = firings.filter((f) => f.agentId === agentId);
      if (agentFirings.length === 0) continue;

      const spec = promptSpecFor(agentId);
      const userMessage = buildUserMessage(agentId, agentFirings, ctx);
      const model = provider.modelFor(ModelTier.Triage);
      const callStarted = Date.now();
      try {
        const result = await provider.generate({
          agentId,
          modelTier: ModelTier.Triage,
          promptId: spec.promptId,
          promptVersion: spec.version,
          messages: [
            { role: "system", content: spec.systemPrompt },
            { role: "user", content: userMessage },
          ],
          outputSchema: agentOutputSchema,
          maxOutputTokens: 4_000,
          temperature: 0.3,
        });
        usageAcc.calls += 1;
        usageAcc.inputTokens += result.usage.inputTokens;
        usageAcc.outputTokens += result.usage.outputTokens;
        usageAcc.costMicros += result.usage.costMicros;
        callLogInserts.push({
          storeId,
          agentId,
          provider: provider.id,
          model,
          modelTier: ModelTier.Triage,
          promptId: spec.promptId,
          promptVersion: spec.version,
          status: "SUCCEEDED",
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costMicros: result.usage.costMicros,
          latencyMs: Date.now() - callStarted,
          requestDigest: requestDigestOf(agentId, model, spec.promptId, userMessage),
          responseDigest: createHash("sha256").update(result.rawJson).digest("hex"),
        });
        const { scored, droppedRefs } = scoreDrafts(agentFirings, result.output.drafts, ctx);
        if (droppedRefs.length > 0) {
          logger.info({ storeId, agentId, droppedRefs }, "ai.run.drafts_dropped");
        }
        scoredAll.push(...scored);
        agentsCompleted += 1;
      } catch (error) {
        const typed =
          error instanceof AiProviderError
            ? error
            : new AiProviderError("PROVIDER_ERROR", error instanceof Error ? error.message : "unknown", false);
        callLogInserts.push({
          storeId,
          agentId,
          provider: provider.id,
          model,
          modelTier: ModelTier.Triage,
          promptId: spec.promptId,
          promptVersion: spec.version,
          status: "FAILED",
          latencyMs: Date.now() - callStarted,
          requestDigest: requestDigestOf(agentId, model, spec.promptId, userMessage),
          errorMessage: `${typed.kind}: ${typed.message}`.slice(0, 1000),
        });
        logger.error({ err: error, storeId, agentId, kind: typed.kind }, "ai.run.agent_failed");
        // UNAVAILABLE / RATE_LIMITED abort the run — partial fan-out would
        // produce a lopsided recommendation set the merchant can't trust.
        if (typed.kind === "UNAVAILABLE" || typed.kind === "RATE_LIMITED") {
          aborted = true;
          partialError = `${agentId}: ${typed.kind}`;
        } else {
          partialError = partialError ?? `${agentId}: ${typed.kind}`;
        }
      }
    }

    const { created, duplicatesSkipped, executions } = await this.persistAndMaybeAutoApprove(
      storeId,
      ctx,
      health,
      scoredAll,
    );

    const status =
      aborted && created.length === 0
        ? AiRunStatus.Failed
        : aborted
          ? AiRunStatus.ProviderUnavailable
          : AiRunStatus.Completed;
    const runId = await this.writeRunRow(storeId, trigger, {
      status,
      health,
      agentsPlanned: AGENT_RUN_ORDER.length,
      agentsCompleted,
      created: created.length,
      duplicatesSkipped,
      usage: usageAcc,
      errorMessage: partialError,
      startedAt,
    });
    const runUuid = runId;
    if (callLogInserts.length > 0) {
      await withStoreScope(db, storeId, async (tx) => {
        await tx.insert(aiCallLogs).values(callLogInserts.map((row) => ({ ...row, runId: runUuid })));
      });
    }

    if (created.length > 0) {
      const highPriority = created.filter((r) => r.priority === "HIGH" || r.priority === "CRITICAL").length;
      await this.deps.notifier.notify(storeId, {
        category: NotificationCategory.Ai,
        title: `${created.length} new AI recommendation${created.length === 1 ? "" : "s"}`,
        body:
          highPriority > 0
            ? `${highPriority} high-priority action${highPriority === 1 ? "" : "s"} ready for review — ${created[0]?.title ?? ""}${created.length > 1 ? ` and ${created.length - 1} more.` : "."}`
            : `Fresh analysis landed — ${created[0]?.title ?? ""}${created.length > 1 ? ` and ${created.length - 1} more.` : "."}`,
        actionUrl: "/recommendations",
      });
    }

    logger.info(
      { storeId, runId, status, created: created.length, duplicatesSkipped, usage: usageAcc },
      "ai.run.finished",
    );

    return {
      runId,
      status,
      health,
      firings: firings.length,
      agentCalls: usageAcc.calls,
      created,
      duplicatesSkipped,
      executionsToEnqueue: executions,
      errorMessage: partialError,
    };
  }

  /**
   * One atomic transaction: dedupe check → insert recommendation + evidence +
   * CREATED event → (policy permitting) AUTO_APPROVED transition + execution
   * row. Ordering fact: withStoreScope serializes per-run writes; the partial
   * unique index is the physical backstop for cross-run races (a violation
   * fails the job, which retries and converges on the now-visible row).
   */
  private async persistAndMaybeAutoApprove(
    storeId: string,
    ctx: BusinessContext,
    _health: StoreHealth,
    scored: readonly ScoredDraft[],
  ): Promise<{
    created: readonly CreatedRecommendation[];
    duplicatesSkipped: number;
    executions: RunSummary["executionsToEnqueue"];
  }> {
    if (scored.length === 0) return { created: [], duplicatesSkipped: 0, executions: [] };
    const db = this.deps.db;
    const rejectHorizon = new Date(Date.now() - REJECT_MEMORY_DAYS * 86_400_000);

    return withStoreScope(db, storeId, async (tx) => {
      const created: CreatedRecommendation[] = [];
      const executions: {
        executionId: string;
        recommendationId: string;
        actionType: (typeof ActionType)[keyof typeof ActionType];
      }[] = [];
      let duplicatesSkipped = 0;

      for (const item of scored) {
        const fingerprint = fingerprintOf(storeId, item);
        const existing = await tx
          .select({ id: recommendations.id, status: recommendations.status })
          .from(recommendations)
          .where(
            and(
              eq(recommendations.storeId, storeId),
              eq(recommendations.fingerprint, fingerprint),
              or(
                inArray(recommendations.status, [
                  RecommendationStatus.PendingApproval,
                  RecommendationStatus.Approved,
                  RecommendationStatus.Scheduled,
                  RecommendationStatus.Executing,
                ]),
                and(
                  eq(recommendations.status, RecommendationStatus.Rejected),
                  gte(recommendations.decidedAt, rejectHorizon),
                ),
              ),
            ),
          )
          .limit(1);
        if (existing[0] !== undefined) {
          duplicatesSkipped += 1;
          continue;
        }

        const estimatedCost = item.firing.estimatedCostCents;
        const estimatedRoi =
          estimatedCost > 0
            ? Math.round((item.firing.estimatedRevenueCents / estimatedCost) * 100) / 100
            : null;
        const inserted = await tx
          .insert(recommendations)
          .values({
            storeId,
            fingerprint,
            type: item.firing.type,
            agentId: item.firing.agentId,
            ruleId: item.firing.ruleId,
            ruleVersion: item.firing.ruleVersion,
            title: item.draft.title.slice(0, 200),
            description: item.draft.description.slice(0, 2000),
            reasoning: item.draft.reasoning.slice(0, 6),
            priority: item.priority,
            confidence: item.confidence,
            riskLevel: item.risk,
            estimatedRevenueCents: item.firing.estimatedRevenueCents,
            estimatedCostCents: estimatedCost,
            subjects: item.firing.subjects,
            actionType: item.firing.actionType,
            actionParams: {
              ...item.firing.executionTemplate,
              ...(item.draft.emailDraft !== null ? { emailDraft: item.draft.emailDraft } : {}),
            },
            status: RecommendationStatus.PendingApproval,
            expiresAt: new Date(Date.now() + item.firing.expiresInDays * 86_400_000),
          })
          .returning({ id: recommendations.id });
        const recId = inserted[0]?.id;
        if (recId === undefined) throw new Error("recommendation insert returned no id");

        await tx.insert(recommendationEvidence).values({
          storeId,
          recommendationId: recId,
          snapshot: {
            computedAt: ctx.computedAt,
            window: ctx.window,
            storeHealthScore: _health.score,
            facts: item.firing.facts,
            rule: { id: item.firing.ruleId, version: item.firing.ruleVersion },
            estimates: {
              revenueCents: item.firing.estimatedRevenueCents,
              costCents: estimatedCost,
              roiMultiple: estimatedRoi,
              expectationBasis: "deterministic rule catalog constants",
            },
            calibration: {
              modelConfidence: item.draft.confidence,
              finalConfidence: item.confidence,
              tier: item.tier,
              modelPriority: item.draft.priority,
              finalPriority: item.priority,
              modelRisk: item.draft.risk,
              finalRisk: item.risk,
            },
            contextDigest: {
              netCents: ctx.revenue.netCents,
              trendPct: ctx.revenue.trendPct,
              ordersCount: ctx.revenue.ordersCount,
              customersTotal: ctx.customers.total,
              abandonedCount: ctx.checkouts.abandonedCount,
              refundsRatePct: ctx.refunds.ratePct,
            },
            model: {
              provider: this.deps.provider?.id ?? null,
              promptId: promptSpecFor(item.firing.agentId).promptId,
              promptVersion: promptSpecFor(item.firing.agentId).version,
            },
          },
        });
        await tx.insert(recommendationEvents).values({
          storeId,
          recommendationId: recId,
          event: RecommendationEventType.Created,
          actorType: EventActorType.Ai,
          fromStatus: null,
          toStatus: RecommendationStatus.PendingApproval,
          details: { ruleId: item.firing.ruleId, confidence: item.confidence, tier: item.tier },
        });

        created.push({
          id: recId,
          type: item.firing.type,
          title: item.draft.title.slice(0, 140),
          priority: item.priority,
        });

        // ── Autopilot (P3 automation modes), merchant-policy-guarded ──────
        const autoDecision = decideAutoApproval(ctx, item);
        if (autoDecision.approve) {
          if (item.firing.actionType === ActionType.Advisory) {
            // Advisory executes inline: record decision + executed outcome, no tool.
            await tx
              .update(recommendations)
              .set({
                status: RecommendationStatus.Executed,
                decidedAt: new Date(),
                stateVersion: 2,
                updatedAt: new Date(),
              })
              .where(eq(recommendations.id, recId));
            await tx.insert(recommendationEvents).values([
              {
                storeId,
                recommendationId: recId,
                event: RecommendationEventType.AutoApproved,
                actorType: EventActorType.System,
                fromStatus: RecommendationStatus.PendingApproval,
                toStatus: RecommendationStatus.Approved,
                details: { reason: autoDecision.reason },
              },
              {
                storeId,
                recommendationId: recId,
                event: RecommendationEventType.Executed,
                actorType: EventActorType.System,
                fromStatus: RecommendationStatus.Approved,
                toStatus: RecommendationStatus.Executed,
                details: { advisory: true },
              },
            ]);
          } else {
            const executionRows = await tx
              .insert(actionExecutions)
              .values({
                storeId,
                recommendationId: recId,
                actionType: item.firing.actionType,
                status: "PENDING",
                idempotencyKey: createHash("sha256")
                  .update(`${recId}|${item.firing.actionType}|v1`)
                  .digest("hex"),
                actionPreview: item.firing.executionTemplate,
              })
              .returning({ id: actionExecutions.id });
            const executionRow = executionRows[0];
            if (executionRow === undefined) throw new Error("execution insert returned no id");
            await tx
              .update(recommendations)
              .set({
                status: RecommendationStatus.Approved,
                decidedAt: new Date(),
                stateVersion: 2,
                updatedAt: new Date(),
              })
              .where(eq(recommendations.id, recId));
            await tx.insert(recommendationEvents).values([
              {
                storeId,
                recommendationId: recId,
                event: RecommendationEventType.AutoApproved,
                actorType: EventActorType.System,
                fromStatus: RecommendationStatus.PendingApproval,
                toStatus: RecommendationStatus.Approved,
                details: { reason: autoDecision.reason, executionId: executionRow.id },
              },
              {
                storeId,
                recommendationId: recId,
                event: RecommendationEventType.ExecutionQueued,
                actorType: EventActorType.System,
                fromStatus: RecommendationStatus.Approved,
                toStatus: RecommendationStatus.Approved,
                details: { executionId: executionRow.id },
              },
            ]);
            executions.push({
              executionId: executionRow.id,
              recommendationId: recId,
              actionType: item.firing.actionType,
            });
          }
        }
      }

      return { created, duplicatesSkipped, executions };
    });
  }

  private async writeRunRow(
    storeId: string,
    trigger: (typeof AiRunTrigger)[keyof typeof AiRunTrigger],
    input: {
      status: (typeof AiRunStatus)[keyof typeof AiRunStatus];
      health: StoreHealth;
      agentsPlanned: number;
      agentsCompleted: number;
      created: number;
      duplicatesSkipped: number;
      usage: { calls: number; inputTokens: number; outputTokens: number; costMicros: number };
      errorMessage: string | null;
      startedAt: Date;
    },
  ): Promise<string> {
    const rows = await withStoreScope(this.deps.db, storeId, async (tx) => {
      return tx
        .insert(aiRuns)
        .values({
          storeId,
          trigger,
          status: input.status,
          storeHealthScore: input.health.score,
          storeHealthBreakdown: { components: input.health.components },
          agentsPlanned: input.agentsPlanned,
          agentsCompleted: input.agentsCompleted,
          recommendationsCreated: input.created,
          duplicatesSkipped: input.duplicatesSkipped,
          usage: input.usage,
          errorMessage: input.errorMessage,
          startedAt: input.startedAt,
          finishedAt: new Date(),
        })
        .returning({ id: aiRuns.id });
    });
    const row = rows[0];
    if (row === undefined) throw new Error("ai_runs insert returned no id");
    return row.id;
  }

  /** Failsafe notify with a 24h cooldown — nightly retries must not spam. */
  private async notifyProviderUnavailable(
    storeId: string,
    trigger: (typeof AiRunTrigger)[keyof typeof AiRunTrigger],
  ): Promise<void> {
    if (trigger === AiRunTrigger.Manual) {
      await this.deps.notifier.notify(storeId, {
        category: NotificationCategory.Ai,
        title: "AI provider not configured",
        body: "Set GEMINI_API_KEY in the platform environment to enable analysis runs. No actions were taken.",
        actionUrl: "/settings",
      });
      return;
    }
    const recent = await withStoreScope(this.deps.db, storeId, async (tx) => {
      return tx
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.storeId, storeId),
            eq(aiRuns.status, AiRunStatus.ProviderUnavailable),
            gte(aiRuns.createdAt, sql`now() - interval '${sql.raw(String(UNAVAILABLE_NOTICE_COOLDOWN_HOURS))} hours'`),
          ),
        )
        .limit(2);
    });
    if (recent.length <= 1) {
      await this.deps.notifier.notify(storeId, {
        category: NotificationCategory.Ai,
        title: "AI analysis is paused",
        body: "The AI provider is unavailable. Analysis retries automatically; no recommendations or automation actions are produced until it recovers.",
        actionUrl: "/ai",
      });
    }
  }
}

/** Autopilot policy: which recommendations may execute without a human click. */
export function decideAutoApproval(
  ctx: BusinessContext,
  item: ScoredDraft,
): { approve: boolean; reason: string } {
  const mode = ctx.policy.mode;
  if (mode === "MANUAL") return { approve: false, reason: "mode MANUAL" };
  if (mode === "SEMI_AUTOMATIC") {
    return item.firing.actionType === ActionType.Advisory
      ? { approve: true, reason: "semi-auto: advisory has no external side effect" }
      : { approve: false, reason: "semi-auto: side-effecting actions need approval" };
  }
  // FULLY_AUTOMATIC — hard guardrails, all of them merchant-set.
  const discount = Number(item.firing.executionTemplate["discountPercent"] ?? 0);
  if (discount > ctx.policy.maxAutoDiscountPercent) {
    return { approve: false, reason: "discount exceeds merchant autopilot cap" };
  }
  if (item.firing.estimatedRevenueCents > ctx.policy.maxAutoApproveEstimatedRevenueCents) {
    return { approve: false, reason: "estimated value exceeds merchant autopilot cap" };
  }
  if (item.confidence < 80) {
    return { approve: false, reason: "confidence below autopilot floor (80)" };
  }
  if (item.risk === "HIGH") return { approve: false, reason: "high-risk actions never auto-approve" };
  return { approve: true, reason: "full-auto: passed merchant guardrails" };
}
