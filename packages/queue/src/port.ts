import type { QueueName } from "@profit/types";
import type { z } from "zod";

/**
 * Queue port (ARCHITECTURE: provider-agnostic infrastructure). Business logic
 * programs ONLY against this interface — BullMQ/Redis is the production
 * driver, the in-process driver serves hermetic tests and single-process
 * deployments without Redis. Swapping drivers must never change behavior
 * visible to job handlers: same validation, lifecycle, and ordering rules.
 *
 * Lifecycle contract (both drivers):
 *   enqueue → (delay?) → validate(payload) → handler attempt 1…N
 *   handler success       → "completed"
 *   handler throws        → retry with exponential backoff + jitter until
 *                           attempts exhausted → "dead" (dead-letter)
 *   invalid payload       → dead immediately (retrying cannot fix data)
 *
 * Deterministic idempotency: enqueueing with a jobId that is already in
 * flight is a no-op returning the existing jobId (P12: duplicate prevention
 * for at-least-once triggers such as webhooks and cron ticks).
 */

export interface JobDefinition<TPayload> {
  /** Stable job name, e.g. "sync.module". Convention: "<domain>.<verb>". */
  readonly name: string;
  readonly queue: QueueName;
  /** Zod contract — validated on enqueue AND before every handler attempt. */
  readonly schema: z.ZodType<TPayload>;
  /** Total attempts including the first. Default 5. */
  readonly attempts?: number;
  /** Base delay for exponential backoff (attempt N waits base * 2^(N-1) + jitter). Default 1000ms. */
  readonly backoffBaseMs?: number;
  /** Per-attempt execution timeout. Default 120_000ms. */
  readonly timeoutMs?: number;
}

export interface EnqueueOptions {
  /** Idempotency key. Defaults to a random uuid. */
  readonly jobId?: string;
  readonly delayMs?: number;
}

export interface JobContext<TPayload> {
  readonly jobId: string;
  readonly name: string;
  readonly queue: QueueName;
  readonly payload: TPayload;
  /** 1-based attempt counter. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type JobHandler<TPayload> = (ctx: JobContext<TPayload>) => Promise<void>;

export type JobEventType = "queued" | "active" | "completed" | "retry" | "dead";

export interface JobEvent {
  readonly type: JobEventType;
  readonly queue: QueueName;
  readonly name: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error?: string;
  readonly durationMs?: number;
}

export type JobEventListener = (event: JobEvent) => void;

export interface ScheduleSpec<TPayload = unknown> {
  /** Stable scheduler identity (idempotent: re-registering replaces, never duplicates). */
  readonly scheduleId: string;
  readonly definition: JobDefinition<TPayload>;
  readonly everyMs: number;
  readonly payload: TPayload;
}

export interface JobQueue {
  enqueue<TPayload>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<string>;

  register<TPayload>(definition: JobDefinition<TPayload>, handler: JobHandler<TPayload>): void;

  /** Start consuming on all queues that have registered handlers. Idempotent. */
  start(): Promise<void>;

  upsertSchedule<TPayload>(schedule: ScheduleSpec<TPayload>): Promise<void>;

  onEvent(listener: JobEventListener): void;

  /** Test/ops helper: resolve true when no waiting/active/scheduled-delayed work remains. */
  waitForIdle(timeoutMs?: number): Promise<boolean>;

  /** Stop consuming and release connections. After close() the instance is unusable. */
  close(): Promise<void>;
}

export const JOB_DEFAULTS = {
  attempts: 5,
  backoffBaseMs: 1_000,
  timeoutMs: 120_000,
} as const;

/** Exponential backoff with ±base/2 jitter — shared exact formula for both drivers. */
export function backoffDelayMs(attempt: number, backoffBaseMs: number): number {
  const jitter = Math.random() * (backoffBaseMs / 2);
  return backoffBaseMs * 2 ** (attempt - 1) + jitter;
}

export class JobExecutionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`job handler exceeded timeout of ${timeoutMs}ms`);
    this.name = "JobExecutionTimeoutError";
  }
}

export class InvalidJobPayloadError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(jobName: string, issues: ReadonlyArray<{ path: string; message: string }>) {
    super(`invalid payload for job "${jobName}": ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "InvalidJobPayloadError";
    this.issues = issues;
  }
}

/**
 * Single timeout-enforcement point shared by both drivers: races the handler
 * against a deadline. A settled handler result arriving later is ignored, so
 * a job never reports both failure and success.
 */
export async function executeWithTimeout<TResult>(
  run: () => Promise<TResult>,
  timeoutMs: number,
): Promise<TResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<TResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new JobExecutionTimeoutError(timeoutMs)), timeoutMs);
      run().then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function validatePayload<TPayload>(
  definition: JobDefinition<TPayload>,
  raw: unknown,
): TPayload {
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidJobPayloadError(
      definition.name,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}
