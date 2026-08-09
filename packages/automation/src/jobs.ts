import { z } from "zod";
import { QueueName, WorkflowTriggerKind } from "@profit/types";
import type { JobDefinition } from "@profit/queue";
import { workflowSubjectSchema } from "./definition";

/**
 * M6 job contracts (P3: "job payload contracts are documented + versioned").
 * One periodic TICK scans the whole M6 plane (schedule-due workflows,
 * delay-resume runs, scheduled campaigns, expired exports) and fans out into
 * idempotent leaf jobs — every leaf carries a deterministic dedupe id so
 * overlapping ticks never double-fire.
 */

export const AutomationTickJob: JobDefinition<Record<string, never>> = {
  name: "automation.tick",
  queue: QueueName.Automation,
  schema: z.object({}).strict(),
  attempts: 2,
  timeoutMs: 60_000,
};

const runStartPayload = z
  .object({
    storeId: z.string().uuid(),
    workflowId: z.string().uuid(),
    triggerKind: z.enum(
      Object.values(WorkflowTriggerKind) as [WorkflowTriggerKind, ...WorkflowTriggerKind[]],
    ),
    triggerEventId: z.string().min(1).max(200),
    subject: workflowSubjectSchema.optional(),
  })
  .strict();
export type WorkflowRunStartPayload = z.infer<typeof runStartPayload>;

export const WorkflowRunStartJob: JobDefinition<WorkflowRunStartPayload> = {
  name: "automation.run-start",
  queue: QueueName.Automation,
  schema: runStartPayload,
  attempts: 3,
  backoffBaseMs: 5_000,
  timeoutMs: 120_000,
};

const runResumePayload = z
  .object({
    storeId: z.string().uuid(),
    runId: z.string().uuid(),
  })
  .strict();
export type WorkflowRunResumePayload = z.infer<typeof runResumePayload>;

export const WorkflowRunResumeJob: JobDefinition<WorkflowRunResumePayload> = {
  name: "automation.run-resume",
  queue: QueueName.Automation,
  schema: runResumePayload,
  attempts: 3,
  backoffBaseMs: 5_000,
  timeoutMs: 120_000,
};

const campaignDispatchPayload = z
  .object({
    storeId: z.string().uuid(),
    campaignId: z.string().uuid(),
  })
  .strict();
export type CampaignDispatchPayload = z.infer<typeof campaignDispatchPayload>;

export const CampaignDispatchJob: JobDefinition<CampaignDispatchPayload> = {
  name: "campaigns.dispatch",
  queue: QueueName.Automation,
  schema: campaignDispatchPayload,
  attempts: 3,
  backoffBaseMs: 5_000,
  timeoutMs: 120_000,
};

const campaignSendBatchPayload = z
  .object({
    storeId: z.string().uuid(),
    campaignId: z.string().uuid(),
    /** Keyset cursor — the last recipient id of the previous batch. */
    afterRecipientId: z.string().uuid().nullable(),
  })
  .strict();
export type CampaignSendBatchPayload = z.infer<typeof campaignSendBatchPayload>;

export const CampaignSendBatchJob: JobDefinition<CampaignSendBatchPayload> = {
  name: "campaigns.send-batch",
  queue: QueueName.Automation,
  schema: campaignSendBatchPayload,
  attempts: 3,
  backoffBaseMs: 10_000,
  timeoutMs: 300_000,
};

const exportGeneratePayload = z
  .object({
    storeId: z.string().uuid(),
    exportId: z.string().uuid(),
  })
  .strict();
export type ExportGeneratePayload = z.infer<typeof exportGeneratePayload>;

export const ExportGenerateJob: JobDefinition<ExportGeneratePayload> = {
  name: "exports.generate",
  queue: QueueName.Export,
  schema: exportGeneratePayload,
  attempts: 2,
  backoffBaseMs: 5_000,
  timeoutMs: 300_000,
};

const supportNotifyPayload = z
  .object({
    storeId: z.string().uuid(),
    ticketId: z.string().uuid(),
    /** The message the notification is about (operator replies only). */
    messageId: z.string().uuid(),
  })
  .strict();
export type SupportNotifyPayload = z.infer<typeof supportNotifyPayload>;

export const SupportNotifyJob: JobDefinition<SupportNotifyPayload> = {
  name: "support.notify",
  queue: QueueName.Notification,
  schema: supportNotifyPayload,
  attempts: 3,
  backoffBaseMs: 5_000,
  timeoutMs: 60_000,
};
