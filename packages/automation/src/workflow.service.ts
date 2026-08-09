import {
  and,
  asc,
  desc,
  eq,
  lt,
  sql,
  withStoreScope,
  workflowRuns,
  workflowRunSteps,
  workflows,
  workflowVersions,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  WorkflowNodeKind,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowStepStatus,
  WorkflowTriggerKind,
  type WorkflowTriggerKind as WorkflowTriggerKindType,
} from "@profit/types";
import { nextOccurrence, parseCron } from "./cron";
import { validateWorkflowDefinition, type DefinitionIssue } from "./dag";
import { triggerNodeOf } from "./dag";
import type { TriggerConfig, WorkflowDefinition } from "./definition";

/**
 * WorkflowService (M6): CRUD + immutable versioning + activation state
 * machine + the scheduler/run queries. Every method runs tenant-scoped
 * (RLS backstop); merchant reads shape the builder UI, the TICK scans run
 * cross-tenant through the owner connection by explicit design (documented
 * platform-ops exception — same class as the M5 billing sweeps).
 */

export class WorkflowValidationError extends Error {
  readonly issues: readonly DefinitionIssue[];

  constructor(issues: readonly DefinitionIssue[]) {
    super(`invalid workflow definition: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    super(`workflow ${id} not found`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStateError";
  }
}

export interface WorkflowRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: (typeof WorkflowStatus)[keyof typeof WorkflowStatus];
  readonly activeVersionId: string | null;
  readonly nextFireAt: Date | null;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkflowVersionRow {
  readonly id: string;
  readonly workflowId: string;
  readonly version: number;
  readonly definition: WorkflowDefinition;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
}

export interface WorkflowRunRow {
  readonly id: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly status: (typeof WorkflowRunStatus)[keyof typeof WorkflowRunStatus];
  readonly triggerKind: WorkflowTriggerKindType;
  readonly triggerEventId: string;
  readonly subject: unknown;
  readonly resumeAt: Date | null;
  readonly resumeFromNodeId: string | null;
  readonly error: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export interface WorkflowRunStepRow {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeKind: (typeof WorkflowNodeKind)[keyof typeof WorkflowNodeKind];
  readonly status: (typeof WorkflowStepStatus)[keyof typeof WorkflowStepStatus];
  readonly attempts: number;
  readonly detail: unknown;
  readonly error: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export function triggerConfigOf(definition: WorkflowDefinition): TriggerConfig {
  return triggerNodeOf(definition).config as TriggerConfig;
}

export class WorkflowService {
  constructor(private readonly db: ProfitDb) {}

  async list(storeId: string): Promise<readonly WorkflowRow[]> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(workflows)
        .where(eq(workflows.storeId, storeId))
        .orderBy(desc(workflows.updatedAt));
      return rows.map((r) => this.toRow(r));
    });
  }

  async get(storeId: string, workflowId: string): Promise<WorkflowRow | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.storeId, storeId)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : this.toRow(row);
    });
  }

  /** Definition the workflow would run right now (active version), or null. */
  async getActiveDefinition(
    storeId: string,
    workflowId: string,
  ): Promise<{ readonly workflow: WorkflowRow; readonly version: WorkflowVersionRow } | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.storeId, storeId)))
        .limit(1);
      const workflow = rows[0];
      if (workflow === undefined || workflow.activeVersionId === null) return null;
      const versions = await tx
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.id, workflow.activeVersionId),
            eq(workflowVersions.storeId, storeId),
          ),
        )
        .limit(1);
      const version = versions[0];
      if (version === undefined) return null;
      return { workflow: this.toRow(workflow), version: this.toVersionRow(version) };
    });
  }

  async listVersions(storeId: string, workflowId: string): Promise<readonly WorkflowVersionRow[]> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(workflowVersions)
        .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.storeId, storeId)))
        .orderBy(desc(workflowVersions.version));
      return rows.map((r) => this.toVersionRow(r));
    });
  }

  /**
   * Create in DRAFT with version 1. The definition is validated first — an
   * invalid graph can never be persisted, so the executor's own re-validation
   * is a pure backstop.
   */
  async create(
    storeId: string,
    input: { name: string; description?: string | null; definition: unknown; createdByUserId?: string | null },
  ): Promise<{ readonly workflow: WorkflowRow; readonly version: WorkflowVersionRow }> {
    const validation = validateWorkflowDefinition(input.definition);
    if (!validation.ok) throw new WorkflowValidationError(validation.issues);
    return withStoreScope(this.db, storeId, async (tx) => {
      const inserted = await tx
        .insert(workflows)
        .values({
          storeId,
          name: input.name,
          description: input.description ?? null,
          status: WorkflowStatus.Draft,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning();
      const workflowsRow = inserted[0];
      if (workflowsRow === undefined) throw new WorkflowStateError("workflow insert returned no row");
      const versionRows = await tx
        .insert(workflowVersions)
        .values({
          storeId,
          workflowId: workflowsRow.id,
          version: 1,
          definition: validation.definition,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning();
      const version = versionRows[0];
      if (version === undefined) throw new WorkflowStateError("version insert returned no row");
      return { workflow: this.toRow(workflowsRow), version: this.toVersionRow(version) };
    });
  }

  /** Rename / re-description without touching the definition (no version bump). */
  async saveMetadata(
    storeId: string,
    workflowId: string,
    input: { name?: string; description?: string | null },
  ): Promise<WorkflowRow> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(workflows)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(workflows.id, workflowId), eq(workflows.storeId, storeId)))
        .returning();
      const row = updated[0];
      if (row === undefined) throw new WorkflowNotFoundError(workflowId);
      return this.toRow(row);
    });
  }

  /** Save a new immutable version (draft editing = version+1). */
  async saveNewVersion(
    storeId: string,
    workflowId: string,
    input: { name?: string; description?: string | null; definition: unknown; createdByUserId?: string | null },
  ): Promise<{ readonly workflow: WorkflowRow; readonly version: WorkflowVersionRow }> {
    const validation = validateWorkflowDefinition(input.definition);
    if (!validation.ok) throw new WorkflowValidationError(validation.issues);
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.storeId, storeId)))
        .limit(1);
      const workflow = rows[0];
      if (workflow === undefined) throw new WorkflowNotFoundError(workflowId);
      if (workflow.status === WorkflowStatus.Archived) {
        throw new WorkflowStateError("archived workflows cannot be edited");
      }
      // Every edit = a new immutable version (max + 1), whether or not the
      // workflow was ever activated — the version trail is append-only.
      const nextVersion = await this.nextVersionNumber(tx, workflowId);
      const versionRows = await tx
        .insert(workflowVersions)
        .values({
          storeId,
          workflowId,
          version: nextVersion,
          definition: validation.definition,
          createdByUserId: input.createdByUserId ?? workflow.createdByUserId,
        })
        .returning();
      const version = versionRows[0];
      if (version === undefined) throw new WorkflowStateError("version insert returned no row");
      const updated = await tx
        .update(workflows)
        .set({
          name: input.name ?? workflow.name,
          description: input.description === undefined ? workflow.description : input.description,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, workflowId))
        .returning();
      const updatedRow = updated[0];
      if (updatedRow === undefined) throw new WorkflowNotFoundError(workflowId);
      return { workflow: this.toRow(updatedRow), version: this.toVersionRow(version) };
    });
  }

  private async nextVersionNumber(tx: ProfitDb, workflowId: string): Promise<number> {
    const rows = await tx
      .select({ maxVersion: sql<number>`coalesce(max(${workflowVersions.version}), 0)::int` })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflowId));
    return (rows[0]?.maxVersion ?? 0) + 1;
  }

  /**
   * Activate a specific version. Computes nextFireAt for SCHEDULE triggers so
   * the very next tick can fire; clears it for other trigger kinds.
   */
  async activate(
    storeId: string,
    workflowId: string,
    versionId: string,
    now = new Date(),
  ): Promise<WorkflowRow> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const versions = await tx
        .select()
        .from(workflowVersions)
        .where(
          and(eq(workflowVersions.id, versionId), eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.storeId, storeId)),
        )
        .limit(1);
      const version = versions[0];
      if (version === undefined) throw new WorkflowStateError("version does not belong to this workflow");
      const definition = version.definition as WorkflowDefinition;
      const trigger = triggerConfigOf(definition);
      const nextFireAt = this.computeNextFire(trigger, now);
      const updated = await tx
        .update(workflows)
        .set({
          status: WorkflowStatus.Active,
          activeVersionId: versionId,
          nextFireAt,
          updatedAt: now,
        })
        .where(and(eq(workflows.id, workflowId), eq(workflows.storeId, storeId)))
        .returning();
      const row = updated[0];
      if (row === undefined) throw new WorkflowNotFoundError(workflowId);
      return this.toRow(row);
    });
  }

  async pause(storeId: string, workflowId: string, now = new Date()): Promise<WorkflowRow> {
    return this.transition(storeId, workflowId, WorkflowStatus.Paused, now);
  }

  async archive(storeId: string, workflowId: string, now = new Date()): Promise<WorkflowRow> {
    return this.transition(storeId, workflowId, WorkflowStatus.Archived, now);
  }

  private async transition(
    storeId: string,
    workflowId: string,
    status: (typeof WorkflowStatus)[keyof typeof WorkflowStatus],
    now: Date,
  ): Promise<WorkflowRow> {
    return withStoreScope(this.db, storeId, async (tx) => {
      // Pausing/archiving disarms the scheduler (nextFireAt cleared) and
      // cancels runs still WAITING on a DELAY — they would never resume.
      const updated = await tx
        .update(workflows)
        .set({ status, nextFireAt: null, updatedAt: now })
        .where(and(eq(workflows.id, workflowId), eq(workflows.storeId, storeId)))
        .returning();
      const row = updated[0];
      if (row === undefined) throw new WorkflowNotFoundError(workflowId);
      await tx
        .update(workflowRuns)
        .set({ status: WorkflowRunStatus.Cancelled, completedAt: now, updatedAt: now })
        .where(
          and(
            eq(workflowRuns.workflowId, workflowId),
            eq(workflowRuns.status, WorkflowRunStatus.Waiting),
          ),
        );
      return this.toRow(row);
    });
  }

  /** SCHEDULE triggers: next UTC fire strictly after `now`; other kinds: null. */
  public computeNextFire(trigger: TriggerConfig, now: Date): Date | null {
    if (trigger.kind !== WorkflowTriggerKind.Schedule) return null;
    const schedule = parseCron(trigger.cron);
    if (schedule === null) return null;
    return nextOccurrence(schedule, now);
  }

  /** RUN history (merchant-facing, newest first, page-sized). */
  async listRuns(
    storeId: string,
    workflowId: string,
    page: number,
    pageSize: number,
  ): Promise<{ readonly runs: readonly WorkflowRunRow[]; readonly total: number }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const offset = (page - 1) * pageSize;
      const rows = await tx
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.storeId, storeId)))
        .orderBy(desc(workflowRuns.createdAt))
        .limit(pageSize)
        .offset(offset);
      const counts = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.storeId, storeId)));
      return { runs: rows.map((r) => this.toRunRow(r)), total: counts[0]?.total ?? 0 };
    });
  }

  /** SCHEDULE-due ACTIVE workflows (TICK scan — owner role, cross-tenant). */
  async findScheduleDue(now: Date): Promise<
    ReadonlyArray<{ readonly storeId: string; readonly workflowId: string; readonly nextFireAt: Date }>
  > {
    const rows = await this.db
      .select({
        storeId: workflows.storeId,
        workflowId: workflows.id,
        nextFireAt: workflows.nextFireAt,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.status, WorkflowStatus.Active),
          sql`${workflows.nextFireAt} IS NOT NULL`,
          sql`${workflows.nextFireAt} <= ${now}`,
        ),
      )
      .orderBy(asc(workflows.nextFireAt))
      .limit(500);
    return rows
      .filter((r): r is typeof r & { nextFireAt: Date } => r.nextFireAt !== null)
      .map((r) => ({ storeId: r.storeId, workflowId: r.workflowId, nextFireAt: r.nextFireAt }));
  }

  /** WAITING runs whose DELAY elapsed (TICK scan — owner role, cross-tenant). */
  async findResumeDue(now: Date): Promise<
    ReadonlyArray<{ readonly storeId: string; readonly runId: string; readonly resumeAt: Date }>
  > {
    const rows = await this.db
      .select({ storeId: workflowRuns.storeId, runId: workflowRuns.id, resumeAt: workflowRuns.resumeAt })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, WorkflowRunStatus.Waiting),
          sql`${workflowRuns.resumeAt} IS NOT NULL`,
          lt(workflowRuns.resumeAt, now),
        ),
      )
      .orderBy(asc(workflowRuns.resumeAt))
      .limit(500);
    // resumeAt drives the resume-job dedupe id: one run can WAIT many times
    // (multi-DELAY graphs), so the bare runId is NOT a safe dedupe key.
    return rows
      .filter((r): r is typeof r & { resumeAt: Date } => r.resumeAt !== null)
      .map((r) => ({ storeId: r.storeId, runId: r.runId, resumeAt: r.resumeAt }));
  }

  /**
   * Next SCHEDULE fire instant for an ACTIVE workflow strictly after `after`
   * (TICK advances nextFireAt to this under CAS). Null when the workflow
   * vanished, lost its pinned version, or has no SCHEDULE trigger.
   */
  async nextFireAfter(storeId: string, workflowId: string, after: Date): Promise<Date | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({ definition: workflowVersions.definition })
        .from(workflows)
        .innerJoin(workflowVersions, eq(workflows.activeVersionId, workflowVersions.id))
        .where(and(eq(workflows.id, workflowId), eq(workflows.storeId, storeId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return this.computeNextFire(triggerConfigOf(row.definition as WorkflowDefinition), after);
    });
  }

  /**
   * ACTIVE workflows whose EVENT trigger matches a processed webhook topic
   * (webhook fan-out — owner role scan, then tenant-scoped run creation).
   */
  async findEventTriggered(
    topic: string,
  ): Promise<ReadonlyArray<{ readonly storeId: string; readonly workflowId: string }>> {
    const rows = await this.db
      .select({ storeId: workflows.storeId, workflowId: workflows.id, definition: workflowVersions.definition })
      .from(workflows)
      .innerJoin(workflowVersions, eq(workflows.activeVersionId, workflowVersions.id))
      .where(eq(workflows.status, WorkflowStatus.Active))
      .limit(1000);
    return rows
      .filter((row) => {
        const definition = row.definition as WorkflowDefinition;
        const trigger = triggerConfigOf(definition);
        return trigger.kind === WorkflowTriggerKind.Event && trigger.topic === topic;
      })
      .map((row) => ({ storeId: row.storeId, workflowId: row.workflowId }));
  }

  /**
   * Advance nextFireAt atomically, guarded on the value the tick observed —
   * a CAS that makes overlapping ticks double-scan but never double-fire a
   * given instant (the run's unique triggerEventId is the second lock).
   */
  async advanceSchedule(storeId: string, workflowId: string, observed: Date, next: Date | null): Promise<boolean> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(workflows)
        .set({ nextFireAt: next, updatedAt: new Date() })
        .where(and(eq(workflows.id, workflowId), eq(workflows.nextFireAt, observed)))
        .returning({ id: workflows.id });
      return updated.length > 0;
    });
  }

  private toRow(row: typeof workflows.$inferSelect): WorkflowRow {
    const { storeId: _storeId, ...rest } = row;
    return rest;
  }

  private toVersionRow(row: typeof workflowVersions.$inferSelect): WorkflowVersionRow {
    const { storeId: _storeId, updatedAt: _updatedAt, ...rest } = row;
    return { ...rest, definition: row.definition as WorkflowDefinition };
  }

  /** Single run for detail views (null when foreign or absent). */
  async getRun(storeId: string, workflowId: string, runId: string): Promise<WorkflowRunRow | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.id, runId),
            eq(workflowRuns.workflowId, workflowId),
            eq(workflowRuns.storeId, storeId),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : this.toRunRow(row);
    });
  }

  /**
   * Step ledger for a run, in creation order. Ownership is verified FIRST in
   * its own scope (never a nested withStoreScope — single-connection drivers
   * serialize transactions on one handle).
   */
  async listRunSteps(
    storeId: string,
    workflowId: string,
    runId: string,
  ): Promise<readonly WorkflowRunStepRow[] | null> {
    const run = await this.getRun(storeId, workflowId, runId);
    if (run === null) return null;
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(workflowRunSteps)
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.storeId, storeId)))
        .orderBy(asc(workflowRunSteps.createdAt));
      return rows.map((r) => this.toStepRow(r));
    });
  }

  private toRunRow(row: typeof workflowRuns.$inferSelect): WorkflowRunRow {
    const { storeId: _storeId, updatedAt: _updatedAt, ...rest } = row;
    return rest;
  }

  private toStepRow(row: typeof workflowRunSteps.$inferSelect): WorkflowRunStepRow {
    const { storeId: _storeId, updatedAt: _updatedAt, ...rest } = row;
    return rest;
  }
}
