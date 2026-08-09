import { z } from "zod";
import { QueueName } from "@profit/types";
import type { JobDefinition } from "@profit/queue";

/**
 * Billing/growth-plane job contracts (P7 trial lifecycle, P2 usage metering,
 * P5 reconciliation). Same rule as sync/ai planes: identical definitions are
 * compiled into the API/worker composition roots — payload drift is a compile
 * error. All ticks are platform-wide scans on the analytics queue (read-heavy,
 * write-light, merchant-volume emails go through the mailer port inline).
 */

export const BillingTrialTickJob: JobDefinition<Record<string, never>> = {
  name: "billing.trial-tick",
  queue: QueueName.Analytics,
  schema: z.object({}).strict(),
  attempts: 1, // the next tick recovers — duplicate-day sends are ledger-deduped
  timeoutMs: 10 * 60_000,
};

export const BillingUsageRollupTickJob: JobDefinition<Record<string, never>> = {
  name: "billing.usage-rollup-tick",
  queue: QueueName.Analytics,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 10 * 60_000,
};

export const BillingReconcileTickJob: JobDefinition<Record<string, never>> = {
  name: "billing.reconcile-tick",
  queue: QueueName.Analytics,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 15 * 60_000,
};

export const BillingChurnScanTickJob: JobDefinition<Record<string, never>> = {
  name: "billing.churn-scan-tick",
  queue: QueueName.Analytics,
  schema: z.object({}).strict(),
  attempts: 1,
  timeoutMs: 10 * 60_000,
};
