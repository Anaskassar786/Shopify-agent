import { eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { backgroundJobs, failedJobs, jobRetries } from "@profit/db";
import { JobStatus } from "@profit/types";
import type { Logger } from "@profit/logger";
import type { JobDefinition, JobEvent, JobQueue } from "./port";

/**
 * Durable job observability (P3/P12): BullMQ/Redis is the execution substrate;
 * Postgres is the queryable mirror. Both producers and consumers share these
 * helpers — producers record QUEUED rows with the idempotency key (unique),
 * consumers attach a listener translating lifecycle events into state columns.
 * failed_jobs is the dead-letter destination ops alert on.
 *
 * Everything here is platform-level by design (owner connection, outside RLS
 * scope): job execution cuts across queues and stores and must never be
 * blocked by tenant policy — the storeId column still records tenancy for
 * reporting, mirroring webhook intake's M1 contract.
 */

export class JobPersistence {
  constructor(
    private readonly db: ProfitDb,
    private readonly logger: Logger,
  ) {}

  /** Producer side — insert the QUEUED row; replay of the same jobId is a no-op. */
  async recordQueued<TPayload>(
    definition: JobDefinition<TPayload>,
    jobId: string,
    payload: TPayload,
    runAt?: Date,
  ): Promise<"inserted" | "duplicate"> {
    const payloadRecord =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    const inserted = await this.db
      .insert(backgroundJobs)
      .values({
        queue: definition.queue,
        jobType: definition.name,
        payload: payloadRecord,
        status: JobStatus.Queued,
        idempotencyKey: jobId,
        ...(typeof payloadRecord["storeId"] === "string"
          ? { storeId: payloadRecord["storeId"] }
          : {}),
        ...(runAt !== undefined ? { runAt } : {}),
      })
      .onConflictDoNothing({ target: backgroundJobs.idempotencyKey })
      .returning({ id: backgroundJobs.id });
    return inserted[0] !== undefined ? "inserted" : "duplicate";
  }

  /** Producer convenience: persist-then-enqueue, atomically consistent (DB first). */
  async enqueuePersistent<TPayload>(
    queue: JobQueue,
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options: { jobId: string; delayMs?: number; runAt?: Date },
  ): Promise<string> {
    await this.recordQueued(definition, options.jobId, payload, options.runAt);
    return queue.enqueue(definition, payload, {
      jobId: options.jobId,
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
    });
  }

  /** Consumer side — translate lifecycle events into durable state. */
  attach(queue: JobQueue): void {
    queue.onEvent((event) => {
      void this.applyEvent(event).catch((error: unknown) => {
        this.logger.error(
          { err: error, jobId: event.jobId, type: event.type },
          "jobs.persistence.failed",
        );
      });
    });
  }

  private async applyEvent(event: JobEvent): Promise<void> {
    const now = new Date();
    switch (event.type) {
      case "active": {
        await this.markRunning(event.jobId, event.attempt, now);
        return;
      }
      case "completed": {
        await this.db
          .update(backgroundJobs)
          .set({
            status: JobStatus.Completed,
            finishedAt: now,
            attempts: event.attempt,
            updatedAt: now,
          })
          .where(eq(backgroundJobs.idempotencyKey, event.jobId));
        return;
      }
      case "retry": {
        const rows = await this.db
          .update(backgroundJobs)
          .set({ attempts: event.attempt, lastError: event.error ?? null, updatedAt: now })
          .where(eq(backgroundJobs.idempotencyKey, event.jobId))
          .returning({ id: backgroundJobs.id });
        const jobRow = rows[0];
        if (jobRow !== undefined) {
          await this.db.insert(jobRetries).values({
            jobId: jobRow.id,
            attempt: event.attempt,
            ...(event.error !== undefined ? { error: event.error } : {}),
          });
        }
        return;
      }
      case "dead": {
        const rows = await this.db
          .update(backgroundJobs)
          .set({
            status: JobStatus.DeadLettered,
            finishedAt: now,
            attempts: event.attempt,
            lastError: event.error ?? null,
            updatedAt: now,
          })
          .where(eq(backgroundJobs.idempotencyKey, event.jobId))
          .returning({
            id: backgroundJobs.id,
            storeId: backgroundJobs.storeId,
            queue: backgroundJobs.queue,
            jobType: backgroundJobs.jobType,
            payload: backgroundJobs.payload,
          });
        const jobRow = rows[0];
        if (jobRow !== undefined) {
          await this.db.insert(failedJobs).values({
            ...(jobRow.storeId !== null ? { storeId: jobRow.storeId } : {}),
            queue: jobRow.queue,
            jobType: jobRow.jobType,
            payload: jobRow.payload as Record<string, unknown>,
            error: event.error ?? "unknown error",
            attemptsMade: event.attempt,
          });
        }
        return;
      }
      case "queued": {
        // Producers persist QUEUED rows themselves (they know the payload).
        return;
      }
    }
  }

  private async markRunning(jobId: string, attempt: number, now: Date): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({
        status: JobStatus.Running,
        attempts: attempt,
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(backgroundJobs.idempotencyKey, jobId));
  }
}
