import { describe, expect, it } from "vitest";
import { AiRunTrigger, QueueName } from "@profit/types";
import {
  AI_SCHEDULES,
  AiExecuteDiscountActionJob,
  AiExecuteEmailActionJob,
  AiMeasureTickJob,
  AiNightlyTickJob,
  AiRunJob,
} from "./jobs";

/**
 * AI job contracts — these definitions are shared verbatim between the API
 * (producer: manual run / approval) and the worker (consumer), so the schema
 * and the retry policy ARE the contract being locked here.
 */

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";
const THIRD_UUID = "33333333-3333-4333-8333-333333333333";

describe("AiRunJob", () => {
  it("targets the AI queue with a single retry and a 10-minute ceiling", () => {
    expect(AiRunJob.name).toBe("ai.run");
    expect(AiRunJob.queue).toBe(QueueName.Ai);
    expect(AiRunJob.attempts).toBe(2);
    expect(AiRunJob.backoffBaseMs).toBe(30_000);
    expect(AiRunJob.timeoutMs).toBe(600_000);
  });

  it("accepts a scheduled payload and preserves the optional requester", () => {
    const parsed = AiRunJob.schema.parse({
      storeId: VALID_UUID,
      trigger: AiRunTrigger.Scheduled,
    });
    expect(parsed).toEqual({ storeId: VALID_UUID, trigger: AiRunTrigger.Scheduled });

    const manual = AiRunJob.schema.parse({
      storeId: VALID_UUID,
      trigger: AiRunTrigger.Manual,
      requestedByUserId: OTHER_UUID,
    });
    expect(manual).toMatchObject({ requestedByUserId: OTHER_UUID });
  });

  it("rejects non-uuid store ids, unknown triggers, and non-uuid requesters", () => {
    expect(() =>
      AiRunJob.schema.parse({ storeId: "store-1", trigger: AiRunTrigger.Scheduled }),
    ).toThrow();
    expect(() => AiRunJob.schema.parse({ storeId: VALID_UUID, trigger: "CRON" })).toThrow();
    expect(() =>
      AiRunJob.schema.parse({
        storeId: VALID_UUID,
        trigger: AiRunTrigger.Manual,
        requestedByUserId: "user-9",
      }),
    ).toThrow();
  });
});

describe("tick jobs", () => {
  it("nightly tick fans the fleet out on the AI queue with no retry (next tick recovers)", () => {
    expect(AiNightlyTickJob.name).toBe("ai.nightly-tick");
    expect(AiNightlyTickJob.queue).toBe(QueueName.Ai);
    expect(AiNightlyTickJob.attempts).toBe(1);
    expect(AiNightlyTickJob.schema.parse({})).toEqual({});
  });

  it("measure tick runs the attribution sweep on the Analytics queue", () => {
    expect(AiMeasureTickJob.name).toBe("ai.measure-tick");
    expect(AiMeasureTickJob.queue).toBe(QueueName.Analytics);
    expect(AiMeasureTickJob.attempts).toBe(1);
    expect(AiMeasureTickJob.schema.parse({})).toEqual({});
  });

  it("tick payloads are closed objects (payload drift is a parse error)", () => {
    expect(() => AiNightlyTickJob.schema.parse({ storeId: VALID_UUID })).toThrow();
    expect(() => AiMeasureTickJob.schema.parse({ extra: true })).toThrow();
  });
});

describe("execution jobs", () => {
  const payload = { storeId: VALID_UUID, recommendationId: OTHER_UUID, executionId: THIRD_UUID };

  it("target the dedicated side-effect queues with bounded retries", () => {
    expect(AiExecuteEmailActionJob.name).toBe("ai.action.execute.email");
    expect(AiExecuteEmailActionJob.queue).toBe(QueueName.Email);
    expect(AiExecuteDiscountActionJob.name).toBe("ai.action.execute.discount");
    expect(AiExecuteDiscountActionJob.queue).toBe(QueueName.Discount);
    for (const job of [AiExecuteEmailActionJob, AiExecuteDiscountActionJob]) {
      expect(job.attempts).toBe(4);
      expect(job.backoffBaseMs).toBe(15_000);
      expect(job.timeoutMs).toBe(180_000);
    }
  });

  it("accept well-formed payloads and reject drift silently-renaming fields", () => {
    expect(AiExecuteEmailActionJob.schema.parse(payload)).toEqual(payload);
    expect(AiExecuteDiscountActionJob.schema.parse(payload)).toEqual(payload);
    expect(() =>
      AiExecuteEmailActionJob.schema.parse({ ...payload, executionId: "not-a-uuid" }),
    ).toThrow();
    expect(() => AiExecuteDiscountActionJob.schema.parse({ storeId: VALID_UUID })).toThrow();
  });
});

describe("AI_SCHEDULES", () => {
  it("defaults to the 6h analysis cadence and 24h measurement cadence", () => {
    expect(AI_SCHEDULES.runEveryMs).toBe(6 * 60 * 60_000);
    expect(AI_SCHEDULES.measureEveryMs).toBe(24 * 60 * 60_000);
  });
});
