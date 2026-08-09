import { z } from "zod";
import { AiRunTrigger, QueueName } from "@profit/types";
import type { JobDefinition } from "@profit/queue";

/**
 * AI-plane job contracts (P3 worker list: AI worker among them). Same rule as
 * the sync plane: definitions are shared verbatim between API (manual run
 * producer) and worker (consumer) — payload drift is a compile error.
 */

const triggerSchema = z.enum([AiRunTrigger.Scheduled, AiRunTrigger.Manual, AiRunTrigger.Event]);

export interface AiRunPayload {
  readonly storeId: string;
  readonly trigger: z.infer<typeof triggerSchema>;
  /** Present on manual runs — the merchant who asked (audit). */
  readonly requestedByUserId?: string | undefined;
}

export const AiRunJob: JobDefinition<AiRunPayload> = {
  name: "ai.run",
  queue: QueueName.Ai,
  schema: z.object({
    storeId: z.string().uuid(),
    trigger: triggerSchema,
    requestedByUserId: z.string().uuid().optional(),
  }),
  attempts: 2, // a failed run retries once, then the next scheduled tick recovers
  backoffBaseMs: 30_000,
  timeoutMs: 10 * 60_000,
};

/** Platform-wide scheduled analysis fan-out (P10 midnight-analysis example, 6h cadence). */
export const AiNightlyTickJob: JobDefinition<Record<string, never>> = {
  name: "ai.nightly-tick",
  queue: QueueName.Ai,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 5 * 60_000,
};

/** Daily measurement + expiry sweep (attribution v1, P3 impact measurement). */
export const AiMeasureTickJob: JobDefinition<Record<string, never>> = {
  name: "ai.measure-tick",
  queue: QueueName.Analytics,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 10 * 60_000,
};

/** Execute one approved, side-effecting recommendation (email-family chains discount+send). */
export interface AiExecuteActionPayload {
  readonly storeId: string;
  readonly recommendationId: string;
  readonly executionId: string;
}

const executeActionSchema = z.object({
  storeId: z.string().uuid(),
  recommendationId: z.string().uuid(),
  executionId: z.string().uuid(),
});

export const AiExecuteEmailActionJob: JobDefinition<AiExecuteActionPayload> = {
  name: "ai.action.execute.email",
  queue: QueueName.Email,
  schema: executeActionSchema,
  attempts: 4,
  backoffBaseMs: 15_000,
  timeoutMs: 3 * 60_000,
};

export const AiExecuteDiscountActionJob: JobDefinition<AiExecuteActionPayload> = {
  name: "ai.action.execute.discount",
  queue: QueueName.Discount,
  schema: executeActionSchema,
  attempts: 4,
  backoffBaseMs: 15_000,
  timeoutMs: 3 * 60_000,
};

/** Cadence constants — env-overridable like the sync schedules. */
export const AI_SCHEDULES = {
  runEveryMs: 6 * 60 * 60_000,
  measureEveryMs: 24 * 60 * 60_000,
} as const;
