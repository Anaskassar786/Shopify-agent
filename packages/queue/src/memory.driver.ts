import { randomUUID } from "node:crypto";
import type { Logger } from "@profit/logger";
import type { QueueName } from "@profit/types";
import {
  backoffDelayMs,
  executeWithTimeout,
  JOB_DEFAULTS,
  validatePayload,
  InvalidJobPayloadError,
  type EnqueueOptions,
  type JobContext,
  type JobDefinition,
  type JobEvent,
  type JobEventListener,
  type JobHandler,
  type JobQueue,
  type ScheduleSpec,
} from "./port";

/**
 * In-process queue driver — a REAL, complete implementation of the JobQueue
 * port (validation, retries with backoff, delays, schedules, dedupe,
 * concurrency, events). Two production-grade uses:
 *   1. Hermetic tests: the exact handlers/payloads that run under BullMQ run
 *      here against real Postgres (PGlite) with zero infrastructure;
 *   2. Single-process deployments without Redis (tiny tenants, local dev) —
 *      jobs persist in the DB mirror (background_jobs) so restarts remain
 *      observable and P12 scale-up is a config change to REDIS_URL, never a
 *      code change.
 * No timers are left running after close(); waitForIdle() gives tests a
 * deterministic completion signal instead of sleeps.
 */

interface QueueEntry {
  readonly handler: JobHandler<never>;
  readonly definition: JobDefinition<never>;
}

interface PendingJob {
  readonly jobId: string;
  readonly name: string;
  readonly queue: QueueName;
  readonly rawPayload: unknown;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly timeoutMs: number;
  readonly runAtMs: number;
}

export interface MemoryJobQueueOptions {
  readonly logger: Logger;
  /** Per-queue concurrency. Default 5. */
  readonly concurrency?: number;
  /** Injectable clock for determinism. */
  readonly now?: () => number;
  /** Dispatcher tick (how often delayed jobs are re-checked). Default 25ms. */
  readonly dispatchIntervalMs?: number;
}

export class MemoryJobQueue implements JobQueue {
  private readonly logger: Logger;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly dispatchIntervalMs: number;
  private readonly handlers = new Map<QueueName, Map<string, QueueEntry>>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly listeners: JobEventListener[] = [];
  private readonly active = new Set<Promise<void>>();
  private readonly activeByQueue = new Map<QueueName, number>();
  private readonly inFlightIds = new Set<string>();
  private running = false;
  private closed = false;

  constructor(options: MemoryJobQueueOptions) {
    this.logger = options.logger.child({ component: "memory-queue" });
    this.concurrency = options.concurrency ?? 5;
    this.now = options.now ?? (() => Date.now());
    this.dispatchIntervalMs = options.dispatchIntervalMs ?? 25;
  }

  async enqueue<TPayload>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options: EnqueueOptions = {},
  ): Promise<string> {
    if (this.closed) throw new Error("queue is closed");
    const jobId = options.jobId ?? randomUUID();
    if (this.inFlightIds.has(jobId)) {
      // At-least-once trigger replaying while in flight: safe no-op.
      return jobId;
    }
    const validated = validatePayload(definition, payload);
    const delayMs = options.delayMs ?? 0;
    const job: PendingJob = {
      jobId,
      name: definition.name,
      queue: definition.queue,
      rawPayload: validated,
      attempt: 1,
      maxAttempts: definition.attempts ?? JOB_DEFAULTS.attempts,
      backoffBaseMs: definition.backoffBaseMs ?? JOB_DEFAULTS.backoffBaseMs,
      timeoutMs: definition.timeoutMs ?? JOB_DEFAULTS.timeoutMs,
      runAtMs: this.now() + delayMs,
    };
    this.inFlightIds.add(jobId);
    this.pending.set(jobId, job);
    this.emit({ type: "queued", queue: job.queue, name: job.name, jobId, attempt: 0, maxAttempts: job.maxAttempts });
    this.scheduleDispatch();
    return Promise.resolve(jobId);
  }

  register<TPayload>(definition: JobDefinition<TPayload>, handler: JobHandler<TPayload>): void {
    const byName = this.handlers.get(definition.queue) ?? new Map<string, QueueEntry>();
    byName.set(definition.name, {
      handler: handler as JobHandler<never>,
      definition: definition as JobDefinition<never>,
    });
    this.handlers.set(definition.queue, byName);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("queue is closed"));
    this.running = true;
    this.scheduleDispatch();
    return Promise.resolve();
  }

  upsertSchedule<TPayload>(schedule: ScheduleSpec<TPayload>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("queue is closed"));
    const fire = (): void => {
      if (this.closed) return;
      void this.enqueue(schedule.definition, schedule.payload, {
        jobId: `schedule:${schedule.scheduleId}:${String(this.now())}`,
      }).catch((error: unknown) => {
        this.logger.error({ err: error, scheduleId: schedule.scheduleId }, "schedule.enqueue.failed");
      });
    };
    const interval = setInterval(fire, schedule.everyMs);
    this.timers.add(interval);
    return Promise.resolve();
  }

  onEvent(listener: JobEventListener): void {
    this.listeners.push(listener);
  }

  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (this.pending.size === 0 && this.active.size === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.pending.size === 0 && this.active.size === 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    // Drain in-flight attempts; pending jobs stay observable via the DB mirror.
    const deadline = this.now() + 10_000;
    while (this.active.size > 0 && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this.pending.clear();
    this.inFlightIds.clear();
  }

  private emit(event: JobEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ err: error }, "queue.event_listener.failed");
      }
    }
  }

  private scheduleDispatch(): void {
    if (!this.running || this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.dispatchDue();
      if (this.running && !this.closed) this.scheduleDispatch();
    }, this.dispatchIntervalMs);
    this.timers.add(timer);
  }

  private dispatchDue(): void {
    const due: PendingJob[] = [];
    for (const job of this.pending.values()) {
      if (job.runAtMs <= this.now()) due.push(job);
    }
    due.sort((a, b) => a.runAtMs - b.runAtMs);
    for (const job of due) {
      const activeInQueue = this.activeByQueue.get(job.queue) ?? 0;
      if (activeInQueue >= this.concurrency) continue;
      if (!this.pending.delete(job.jobId)) continue;
      this.activeByQueue.set(job.queue, activeInQueue + 1);
      const execution = this.execute(job).finally(() => {
        this.active.delete(execution);
        this.activeByQueue.set(
          job.queue,
          Math.max((this.activeByQueue.get(job.queue) ?? 1) - 1, 0),
        );
      });
      this.active.add(execution);
    }
  }

  private async execute(job: PendingJob): Promise<void> {
    const entry = this.handlers.get(job.queue)?.get(job.name);
    const startedAt = this.now();
    if (entry === undefined) {
      this.logger.error({ jobId: job.jobId, name: job.name, queue: job.queue }, "queue.handler_missing");
      this.finishDead(job, `no handler registered for job ${job.name}`, startedAt);
      return;
    }

    this.emit({ type: "active", queue: job.queue, name: job.name, jobId: job.jobId, attempt: job.attempt, maxAttempts: job.maxAttempts });

    try {
      const payload = validatePayload(entry.definition, job.rawPayload);
      const ctx: JobContext<unknown> = {
        jobId: job.jobId,
        name: job.name,
        queue: job.queue,
        payload,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
      };
      await executeWithTimeout(() => entry.handler(ctx as JobContext<never>), job.timeoutMs);
      this.inFlightIds.delete(job.jobId);
      this.emit({
        type: "completed",
        queue: job.queue,
        name: job.name,
        jobId: job.jobId,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        durationMs: this.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof InvalidJobPayloadError || job.attempt >= job.maxAttempts) {
        this.finishDead(job, message, startedAt);
        return;
      }
      this.emit({
        type: "retry",
        queue: job.queue,
        name: job.name,
        jobId: job.jobId,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        error: message,
      });
      const delayMs = backoffDelayMs(job.attempt, job.backoffBaseMs);
      this.pending.set(job.jobId, {
        ...job,
        attempt: job.attempt + 1,
        runAtMs: this.now() + delayMs,
      });
    }
  }

  private finishDead(job: PendingJob, error: string, startedAt: number): void {
    this.inFlightIds.delete(job.jobId);
    this.logger.error({ jobId: job.jobId, name: job.name, error }, "queue.job.dead");
    this.emit({
      type: "dead",
      queue: job.queue,
      name: job.name,
      jobId: job.jobId,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      error,
      durationMs: this.now() - startedAt,
    });
  }
}
