import { describe, expect, it } from "vitest";
import { QueueName } from "@profit/types";
import {
  BillingChurnScanTickJob,
  BillingReconcileTickJob,
  BillingTrialTickJob,
  BillingUsageRollupTickJob,
} from "./jobs";

const ALL_TICKS = [
  BillingTrialTickJob,
  BillingUsageRollupTickJob,
  BillingReconcileTickJob,
  BillingChurnScanTickJob,
] as const;

describe("billing/growth tick job contracts", () => {
  it("has four uniquely-named platform ticks, all on the analytics queue", () => {
    expect(new Set(ALL_TICKS.map((job) => job.name)).size).toBe(4);
    for (const job of ALL_TICKS) {
      expect(job.name.startsWith("billing.")).toBe(true);
      expect(job.queue).toBe(QueueName.Analytics);
      // Ticks are ledger-deduped: the next schedule recovers, so no retries.
      expect(job.attempts).toBe(1);
      expect(job.timeoutMs).toBeGreaterThanOrEqual(10 * 60_000);
    }
  });

  it("payloads are empty-object contracts (strict: drift is a validation error)", () => {
    for (const job of ALL_TICKS) {
      expect(job.schema.parse({})).toEqual({});
      expect(job.schema.safeParse({ storeId: "x" }).success).toBe(false);
    }
  });
});
