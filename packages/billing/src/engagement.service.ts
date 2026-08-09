import {
  count,
  desc,
  eq,
  engagementEvents,
  inArray,
  sql,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { ENGAGEMENT_MILESTONE_KINDS, EngagementEventKind } from "@profit/types";

/**
 * EngagementService — the single writer/reader of engagement_events (P11
 * activation funnel + churn detection share one honest source).
 *
 * Milestone kinds are deduped by the partial unique index; emit() uses
 * ON CONFLICT DO NOTHING so concurrent/double fires are free of ceremony.
 */

export interface EmitInput {
  readonly storeId: string;
  readonly kind: EngagementEventKind;
  readonly userId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class EngagementService {
  constructor(private readonly db: ProfitDb) {}

  /**
   * Persist an event. Returns true when a NEW row landed (false = milestone
   * already recorded). Callers use the result to trigger first-time journeys
   * (e.g. welcome email only on the real first milestone).
   */
  async emit(input: EmitInput): Promise<boolean> {
    const inserted = await this.db
      .insert(engagementEvents)
      .values({
        storeId: input.storeId,
        kind: input.kind,
        userId: input.userId ?? null,
        metadata: input.metadata ?? {},
      })
      // Partial unique index arbitration: Postgres infers a matching arbiter
      // ONLY when the ON CONFLICT clause repeats the index predicate — keep it
      // derived from ENGAGEMENT_MILESTONE_KINDS so it can never drift from the
      // migration literal. Non-milestone kinds fall outside the predicate, so
      // they always insert (view events repeat by design).
      .onConflictDoNothing({
        target: [engagementEvents.storeId, engagementEvents.kind],
        where: inArray(engagementEvents.kind, [...ENGAGEMENT_MILESTONE_KINDS]),
      })
      .returning({ id: engagementEvents.id });
    return inserted[0] !== undefined;
  }

  /** Latest activity timestamp per store (churn detection input). */
  async lastActivityAt(storeId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ lastSeen: sql<Date | null>`max(${engagementEvents.createdAt})` })
      .from(engagementEvents)
      .where(eq(engagementEvents.storeId, storeId));
    return rows[0]?.lastSeen ?? null;
  }

  async recentEvents(storeId: string, limit = 50): Promise<readonly (typeof engagementEvents.$inferSelect)[]> {
    return this.db
      .select()
      .from(engagementEvents)
      .where(eq(engagementEvents.storeId, storeId))
      .orderBy(desc(engagementEvents.createdAt))
      .limit(limit);
  }

  /**
   * Platform activation funnel (admin read-model): stores that hit each
   * milestone, in order, plus conversion vs the preceding step.
   */
  async funnel(): Promise<
    readonly { kind: EngagementEventKind; stores: number; conversionFromPreviousPct: number | null }[]
  > {
    // Milestone rows are unique per (store, kind) — row counts ARE store counts.
    const counts = await this.db
      .select({ kind: engagementEvents.kind, stores: count() })
      .from(engagementEvents)
      .where(inArray(engagementEvents.kind, [...ENGAGEMENT_MILESTONE_KINDS]))
      .groupBy(engagementEvents.kind);
    const byKind = new Map(counts.map((row) => [row.kind, row.stores]));
    let previous: number | null = null;
    return ENGAGEMENT_MILESTONE_KINDS.map((kind) => {
      const stores = byKind.get(kind) ?? 0;
      const conversionFromPreviousPct =
        previous === null
          ? null
          : previous === 0
            ? 0
            : Math.round((stores / previous) * 1000) / 10;
      previous = stores;
      return { kind, stores, conversionFromPreviousPct };
    });
  }
}
