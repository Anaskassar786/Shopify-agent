import { z } from "zod";
import { QueueName } from "@profit/types";
import type { JobDefinition } from "@profit/queue";

/**
 * Reporting pipeline jobs (M8): one nightly tick fans out per active store;
 * each store job converges the merchant's due cadences. Leaf jobIds are
 * dedupe-stable (`reports:generate:{day}:{storeId}`) so a repeated tick never
 * double-generates.
 */

export const ReportsTickJob: JobDefinition<Record<string, never>> = {
  name: "reports.tick",
  queue: QueueName.Reporting,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 5 * 60_000,
};

export const reportGeneratePayloadSchema = z
  .object({ storeId: z.string().uuid() })
  .strict();
export type ReportsGeneratePayload = z.infer<typeof reportGeneratePayloadSchema>;

export const ReportsGenerateJob: JobDefinition<ReportsGeneratePayload> = {
  name: "reports.generate",
  queue: QueueName.Reporting,
  schema: reportGeneratePayloadSchema,
  attempts: 3,
  backoffBaseMs: 30_000,
  timeoutMs: 3 * 60_000,
};
