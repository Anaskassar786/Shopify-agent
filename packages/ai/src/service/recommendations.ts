import { createHash } from "node:crypto";
import { and, count, desc, eq, type SQL } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  actionExecutions,
  recommendations,
  recommendationEvents,
  recommendationEvidence,
  withStoreScope,
} from "@profit/db";
import {
  ActionType,
  EventActorType,
  Priority,
  RecommendationEventType,
  RecommendationStatus,
  type RecommendationStatus as RecommendationStatusT,
} from "@profit/types";
import { z } from "zod";

/**
 * Recommendation state machine (P3/P10 human approval flow). Transitions are
 * enforced by one transition table + compare-and-swap writes on stateVersion
 * — a lost update (double-approve race) is physically impossible, and every
 * legal transition appends its audit event in the same transaction.
 */

const TRANSITIONS: Readonly<Record<string, readonly RecommendationStatusT[]>> = {
  [RecommendationStatus.PendingApproval]: [
    RecommendationStatus.Approved,
    RecommendationStatus.Rejected,
    RecommendationStatus.Expired,
  ],
  [RecommendationStatus.Approved]: [
    RecommendationStatus.Executing,
    RecommendationStatus.Executed, // advisory instant path
    RecommendationStatus.Failed,
    RecommendationStatus.Expired,
  ],
  [RecommendationStatus.Scheduled]: [
    RecommendationStatus.Executing,
    RecommendationStatus.Failed,
    RecommendationStatus.Expired,
  ],
  [RecommendationStatus.Executing]: [
    RecommendationStatus.Executed,
    RecommendationStatus.Failed,
  ],
  [RecommendationStatus.Failed]: [RecommendationStatus.Executed], // manual retry path
  [RecommendationStatus.Executed]: [RecommendationStatus.Measured],
  [RecommendationStatus.Rejected]: [],
  [RecommendationStatus.Expired]: [],
  [RecommendationStatus.Measured]: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: RecommendationStatusT, to: RecommendationStatusT) {
    super(`invalid recommendation transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class RecommendationConflictError extends Error {
  constructor(id: string) {
    super(`recommendation ${id} changed concurrently — reload and retry`);
    this.name = "RecommendationConflictError";
  }
}

export class RecommendationNotFoundError extends Error {
  constructor(id: string) {
    super(`recommendation ${id} not found`);
    this.name = "RecommendationNotFoundError";
  }
}

export const listFiltersSchema = z.object({
  status: z.nativeEnum(RecommendationStatus).optional(),
  type: z.string().max(64).optional(),
  priority: z.nativeEnum(Priority).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});
export type ListFilters = z.infer<typeof listFiltersSchema>;

export const decisionInputSchema = z.object({
  reason: z.string().max(500).optional(),
});

export interface RecommendationRow {
  readonly id: string;
  readonly storeId: string;
  readonly type: string;
  readonly agentId: string;
  readonly ruleId: string;
  readonly title: string;
  readonly description: string;
  readonly reasoning: readonly string[];
  readonly priority: string;
  readonly confidence: number;
  readonly riskLevel: string;
  readonly estimatedRevenueCents: number;
  readonly estimatedCostCents: number;
  readonly subjects: unknown;
  readonly actionType: string;
  readonly actionParams: unknown;
  readonly status: string;
  readonly stateVersion: number;
  readonly decidedByUserId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface RecommendationDetail extends RecommendationRow {
  readonly evidence: unknown;
  readonly events: readonly {
    readonly id: string;
    readonly event: string;
    readonly actorType: string;
    readonly actorUserId: string | null;
    readonly fromStatus: string | null;
    readonly toStatus: string | null;
    readonly details: unknown;
    readonly createdAt: Date;
  }[];
  readonly executions: readonly {
    readonly id: string;
    readonly actionType: string;
    readonly status: string;
    readonly actionPreview: unknown;
    readonly toolRef: unknown;
    readonly errorMessage: string | null;
    readonly attempts: number;
    readonly createdAt: Date;
    readonly finishedAt: Date | null;
  }[];
}

function toRow(row: typeof recommendations.$inferSelect): RecommendationRow {
  return {
    id: row.id,
    storeId: row.storeId,
    type: row.type,
    agentId: row.agentId,
    ruleId: row.ruleId,
    title: row.title,
    description: row.description,
    reasoning: (row.reasoning as readonly string[]) ?? [],
    priority: row.priority,
    confidence: row.confidence,
    riskLevel: row.riskLevel,
    estimatedRevenueCents: row.estimatedRevenueCents,
    estimatedCostCents: row.estimatedCostCents,
    subjects: row.subjects,
    actionType: row.actionType,
    actionParams: row.actionParams,
    status: row.status,
    stateVersion: row.stateVersion,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export class RecommendationService {
  constructor(private readonly db: ProfitDb) {}

  async list(
    storeId: string,
    filters: ListFilters,
  ): Promise<{ rows: readonly RecommendationRow[]; total: number }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const conditions: SQL[] = [eq(recommendations.storeId, storeId)];
      if (filters.status !== undefined) conditions.push(eq(recommendations.status, filters.status));
      if (filters.type !== undefined) conditions.push(eq(recommendations.type, filters.type as never));
      if (filters.priority !== undefined)
        conditions.push(eq(recommendations.priority, filters.priority));
      const where = and(...conditions);
      const [rows, totals] = await Promise.all([
        tx
          .select()
          .from(recommendations)
          .where(where)
          .orderBy(desc(recommendations.createdAt))
          .limit(filters.pageSize)
          .offset((filters.page - 1) * filters.pageSize),
        tx.select({ value: count() }).from(recommendations).where(where),
      ]);
      return { rows: rows.map(toRow), total: totals[0]?.value ?? 0 };
    });
  }

  async detail(storeId: string, id: string): Promise<RecommendationDetail | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(recommendations)
        .where(and(eq(recommendations.id, id), eq(recommendations.storeId, storeId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      const [evidenceRows, eventRows, executionRows] = await Promise.all([
        tx
          .select()
          .from(recommendationEvidence)
          .where(eq(recommendationEvidence.recommendationId, id))
          .limit(1),
        tx
          .select()
          .from(recommendationEvents)
          .where(eq(recommendationEvents.recommendationId, id))
          .orderBy(recommendationEvents.createdAt),
        tx
          .select()
          .from(actionExecutions)
          .where(eq(actionExecutions.recommendationId, id))
          .orderBy(desc(actionExecutions.createdAt)),
      ]);
      return {
        ...toRow(row),
        evidence: evidenceRows[0]?.snapshot ?? null,
        events: eventRows.map((event) => ({
          id: event.id,
          event: event.event,
          actorType: event.actorType,
          actorUserId: event.actorUserId,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          details: event.details,
          createdAt: event.createdAt,
        })),
        executions: executionRows.map((execution) => ({
          id: execution.id,
          actionType: execution.actionType,
          status: execution.status,
          actionPreview: execution.actionPreview,
          toolRef: execution.toolRef,
          errorMessage: execution.errorMessage,
          attempts: execution.attempts,
          createdAt: execution.createdAt,
          finishedAt: execution.finishedAt,
        })),
      };
    });
  }

  /**
   * APPROVE: PENDING_APPROVAL → APPROVED (+execution row + enqueuable effect).
   * Returns the execution the API must enqueue — the queue write stays in the
   * composition layer so this service never touches transport.
   */
  async approve(
    storeId: string,
    id: string,
    userId: string,
  ): Promise<{
    row: RecommendationRow;
    execution: { executionId: string; actionType: (typeof ActionType)[keyof typeof ActionType] } | null;
  }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const current = await this.loadForUpdate(tx, storeId, id);
      this.assertTransition(current.status, RecommendationStatus.Approved);

      const updated = await tx
        .update(recommendations)
        .set({
          status: RecommendationStatus.Approved,
          decidedByUserId: userId,
          decidedAt: new Date(),
          stateVersion: current.stateVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(recommendations.id, id),
            eq(recommendations.stateVersion, current.stateVersion),
          ),
        )
        .returning();
      const next = updated[0];
      if (next === undefined) throw new RecommendationConflictError(id);

      await tx.insert(recommendationEvents).values({
        storeId,
        recommendationId: id,
        event: RecommendationEventType.Approved,
        actorType: EventActorType.Merchant,
        actorUserId: userId,
        fromStatus: current.status,
        toStatus: RecommendationStatus.Approved,
        details: {},
      });

      if (next.actionType === ActionType.Advisory) {
        // Advisory completes inline: no tool, no side effect — the approval
        // itself IS the execution (decision recorded, trail complete).
        const executed = await tx
          .update(recommendations)
          .set({
            status: RecommendationStatus.Executed,
            stateVersion: next.stateVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(recommendations.id, id))
          .returning();
        const executedRow = executed[0];
        if (executedRow === undefined) throw new RecommendationConflictError(id);
        await tx.insert(recommendationEvents).values({
          storeId,
          recommendationId: id,
          event: RecommendationEventType.Executed,
          actorType: EventActorType.System,
          fromStatus: RecommendationStatus.Approved,
          toStatus: RecommendationStatus.Executed,
          details: { advisory: true },
        });
        return { row: toRow(executedRow), execution: null };
      }
      const executionRows = await tx
        .insert(actionExecutions)
        .values({
          storeId,
          recommendationId: id,
          actionType: next.actionType,
          status: "PENDING",
          idempotencyKey: createHash("sha256")
            .update(`${id}|${next.actionType}|v1`)
            .digest("hex"),
          actionPreview: next.actionParams,
        })
        .returning({ id: actionExecutions.id });
      const execution = executionRows[0];
      if (execution === undefined) throw new Error("execution insert returned no id");
      await tx.insert(recommendationEvents).values({
        storeId,
        recommendationId: id,
        event: RecommendationEventType.ExecutionQueued,
        actorType: EventActorType.System,
        fromStatus: RecommendationStatus.Approved,
        toStatus: RecommendationStatus.Approved,
        details: { executionId: execution.id },
      });
      return {
        row: toRow(next),
        execution: { executionId: execution.id, actionType: next.actionType },
      };
    });
  }

  /** REJECT: PENDING_APPROVAL → REJECTED. Reason feeds the learning loop. */
  async reject(
    storeId: string,
    id: string,
    userId: string,
    reason: string | undefined,
  ): Promise<RecommendationRow> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const current = await this.loadForUpdate(tx, storeId, id);
      this.assertTransition(current.status, RecommendationStatus.Rejected);
      const updated = await tx
        .update(recommendations)
        .set({
          status: RecommendationStatus.Rejected,
          decidedByUserId: userId,
          decidedAt: new Date(),
          decisionReason: reason ?? null,
          stateVersion: current.stateVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(recommendations.id, id),
            eq(recommendations.stateVersion, current.stateVersion),
          ),
        )
        .returning();
      const next = updated[0];
      if (next === undefined) throw new RecommendationConflictError(id);
      await tx.insert(recommendationEvents).values({
        storeId,
        recommendationId: id,
        event: RecommendationEventType.Rejected,
        actorType: EventActorType.Merchant,
        actorUserId: userId,
        fromStatus: current.status,
        toStatus: RecommendationStatus.Rejected,
        details: reason !== undefined ? { reason } : {},
      });
      return toRow(next);
    });
  }

  private async loadForUpdate(
    tx: ProfitDb,
    storeId: string,
    id: string,
  ): Promise<typeof recommendations.$inferSelect> {
    const rows = await tx
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.id, id), eq(recommendations.storeId, storeId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new RecommendationNotFoundError(id);
    return row;
  }

  private assertTransition(from: RecommendationStatusT, to: RecommendationStatusT): void {
    const allowed = TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) throw new InvalidTransitionError(from, to);
  }
}

/** Open statuses — exposed for the expiry sweep + dashboard counts. */
export const OPEN_STATUSES: readonly RecommendationStatusT[] = [
  RecommendationStatus.PendingApproval,
  RecommendationStatus.Approved,
  RecommendationStatus.Scheduled,
  RecommendationStatus.Executing,
];
