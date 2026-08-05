import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker, type ConnectionOptions } from "bullmq";
import type { Logger } from "@profit/logger";
import type { QueueName } from "@profit/types";
import {
  executeWithTimeout,
  JOB_DEFAULTS,
  validatePayload,
  InvalidJobPayloadError,
  type EnqueueOptions,
  type JobDefinition,
  type JobEvent,
  type JobEventListener,
  type JobHandler,
  type JobQueue,
  type ScheduleSpec,
} from "./port";

/**
 * Production driver: BullMQ on Redis (P3/P12 background jobs; BullMQ listed
 * by the spec as THE queue substrate). Responsibilities split exactly as the
 * port promises: Redis gives durability, distributed concurrency and delayed
 * retries; this class maps it onto the same lifecycle events and validation
 * rules as the in-process driver, so handlers are driver-agnostic.
 *
 * Retry/dead-letter mapping:
 *   BullMQ per-attempt "failed"  → port "retry" event (attemptsMade < attempts)
 *   BullMQ final "failed"        → port "dead" event (dead-letter; mirrored to
 *                                  failed_jobs by the persistence layer)
 * Invalid payloads never retry here either (schema check precedes handler).
 */

export interface BullMqJobQueueOptions {
  readonly logger: Logger;
  readonly connection: ConnectionOptions;
  /** Per-queue worker concurrency. Default 10. */
  readonly concurrency?: number;
  readonly queuePrefix?: string;
}

interface Registration {
  readonly handler: JobHandler<never>;
  readonly definition: JobDefinition<never>;
}

export class BullMqJobQueue implements JobQueue {
  private readonly logger: Logger;
  private readonly connection: ConnectionOptions;
  private readonly concurrency: number;
  private readonly prefix: string;
  private readonly registrations = new Map<QueueName, Map<string, Registration>>();
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();
  private readonly events = new Map<QueueName, QueueEvents>();
  private readonly listeners: JobEventListener[] = [];
  private started = false;
  private closed = false;

  constructor(options: BullMqJobQueueOptions) {
    this.logger = options.logger.child({ component: "bullmq-queue" });
    this.connection = options.connection;
    this.concurrency = options.concurrency ?? 10;
    this.prefix = options.queuePrefix ?? "profit";
  }

  private queueFor(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing !== undefined) return existing;
    const queue = new Queue(name, {
      connection: this.connection,
      prefix: this.prefix,
      defaultJobOptions: {
        removeOnComplete: { age: 24 * 3600, count: 5_000 },
        removeOnFail: false,
      },
    });
    this.queues.set(name, queue);
    return queue;
  }

  async enqueue<TPayload>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options: EnqueueOptions = {},
  ): Promise<string> {
    if (this.closed) throw new Error("queue is closed");
    const validated = validatePayload(definition, payload);
    const jobId = options.jobId ?? randomUUID();
    const attempts = definition.attempts ?? JOB_DEFAULTS.attempts;
    const backoffBaseMs = definition.backoffBaseMs ?? JOB_DEFAULTS.backoffBaseMs;
    const queue = this.queueFor(definition.queue);
    const job = await queue.add(definition.name, validated as object, {
      jobId,
      attempts,
      backoff: { type: "exponential", delay: backoffBaseMs },
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
    });
    // BullMQ silently reuses an in-flight jobId — both branches are the
    // port's promised no-op replay semantics.
    const emitted = { type: "queued" as const, queue: definition.queue, name: definition.name, jobId, attempt: 0, maxAttempts: attempts };
    this.emit(emitted);
    return job.id ?? jobId;
  }

  register<TPayload>(definition: JobDefinition<TPayload>, handler: JobHandler<TPayload>): void {
    const byName = this.registrations.get(definition.queue) ?? new Map<string, Registration>();
    byName.set(definition.name, {
      handler: handler as JobHandler<never>,
      definition: definition as JobDefinition<never>,
    });
    this.registrations.set(definition.queue, byName);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("queue is closed");
    if (this.started) return;
    this.started = true;

    for (const [queueName, byName] of this.registrations) {
      const worker = new Worker(
        queueName,
        async (bullJob) => {
          const registration = byName.get(bullJob.name);
          if (registration === undefined) {
            throw new Error(`no handler registered for job ${bullJob.name}`);
          }
          const definition = registration.definition;
          const payload = validatePayload(definition, bullJob.data);
          const timeoutMs = definition.timeoutMs ?? JOB_DEFAULTS.timeoutMs;
          await executeWithTimeout(
            () =>
              registration.handler({
                jobId: bullJob.id ?? "unknown",
                name: bullJob.name,
                queue: queueName,
                payload,
                attempt: bullJob.attemptsMade + 1,
                maxAttempts: bullJob.opts.attempts ?? JOB_DEFAULTS.attempts,
              }),
            timeoutMs,
          );
        },
        {
          connection: this.connection,
          prefix: this.prefix,
          concurrency: this.concurrency,
        },
      );
      this.workers.set(queueName, worker);

      const events = new QueueEvents(queueName, {
        connection: this.connection,
        prefix: this.prefix,
      });
      await events.waitUntilReady();

      const emitForJob = (
        type: "completed" | "failed",
        jobId: string,
        error?: string,
      ): void => {
        void this.queueFor(queueName)
          .getJob(jobId)
          .then((fetched) => {
            const attempts = fetched?.opts.attempts ?? JOB_DEFAULTS.attempts;
            const attemptsMade = fetched?.attemptsMade ?? 1;
            const event: JobEvent = {
              type:
                type === "failed"
                  ? attemptsMade >= attempts ||
                    (error ?? "").startsWith("invalid payload")
                    ? "dead"
                    : "retry"
                  : type,
              queue: queueName,
              name: fetched?.name ?? "unknown",
              jobId,
              attempt: attemptsMade,
              maxAttempts: attempts,
              ...(error !== undefined ? { error } : {}),
            };
            this.emit(event);
          })
          .catch((lookupError: unknown) => {
            this.logger.error({ err: lookupError, jobId, queue: queueName }, "queue.event_lookup.failed");
          });
      };
      events.on("completed", ({ jobId }) => emitForJob("completed", jobId));
      events.on("failed", ({ jobId, failedReason }) => emitForJob("failed", jobId, failedReason));
      void byName;
      this.events.set(queueName, events);
    }
    this.logger.info({ queues: [...this.registrations.keys()] }, "queue.workers.started");
  }

  async upsertSchedule<TPayload>(schedule: ScheduleSpec<TPayload>): Promise<void> {
    if (this.closed) throw new Error("queue is closed");
    const queue = this.queueFor(schedule.definition.queue);
    await queue.upsertJobScheduler(
      schedule.scheduleId,
      { every: schedule.everyMs },
      {
        name: schedule.definition.name,
        data: schedule.payload as object,
        opts: {
          attempts: schedule.definition.attempts ?? JOB_DEFAULTS.attempts,
          backoff: {
            type: "exponential",
            delay: schedule.definition.backoffBaseMs ?? JOB_DEFAULTS.backoffBaseMs,
          },
        },
      },
    );
  }

  onEvent(listener: JobEventListener): void {
    this.listeners.push(listener);
  }

  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let idle = true;
      for (const queue of this.queues.values()) {
        const counts = await queue.getJobCounts("wait", "active", "delayed", "prioritized");
        if ((counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0) > 0) {
          idle = false;
          break;
        }
      }
      if (idle) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workers.values()].map((worker) => worker.close()));
    await Promise.all([...this.events.values()].map((events) => events.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.workers.clear();
    this.events.clear();
    this.queues.clear();
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
}
