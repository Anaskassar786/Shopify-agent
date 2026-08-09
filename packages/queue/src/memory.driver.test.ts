import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@profit/logger";
import { QueueName } from "@profit/types";
import { z } from "zod";
import { MemoryJobQueue } from "./memory.driver";
import { InvalidJobPayloadError, type JobDefinition, type JobEvent } from "./port";

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: "fatal", service: "queue-test", environment: "test", destination: sink });

interface TestPayload {
  readonly storeId: string;
  readonly value: number;
}

const testJob: JobDefinition<TestPayload> = {
  name: "test.echo",
  queue: QueueName.Sync,
  schema: z.object({ storeId: z.string().uuid(), value: z.number().int() }),
  attempts: 3,
  backoffBaseMs: 1,
  timeoutMs: 250,
};

const STORE_ID = "11111111-2222-3333-4444-555555555555";

function makeQueue(concurrency = 5): MemoryJobQueue {
  return new MemoryJobQueue({ logger, concurrency, dispatchIntervalMs: 2 });
}

let queues: MemoryJobQueue[] = [];
function tracked(): MemoryJobQueue {
  const q = makeQueue();
  queues.push(q);
  return q;
}

afterEach(async () => {
  await Promise.all(queues.map((q) => q.close()));
  queues = [];
});

describe("MemoryJobQueue", () => {
  it("runs a registered handler exactly once and emits queued→active→completed", async () => {
    const queue = tracked();
    const events: JobEvent[] = [];
    const seen: Array<{ payload: TestPayload; attempt: number }> = [];
    queue.onEvent((e) => events.push(e));
    queue.register(testJob, async (ctx) => {
      seen.push({ payload: ctx.payload, attempt: ctx.attempt });
    });
    await queue.start();
    const jobId = await queue.enqueue(testJob, { storeId: STORE_ID, value: 7 });
    expect(await queue.waitForIdle()).toBe(true);
    expect(seen).toEqual([{ payload: { storeId: STORE_ID, value: 7 }, attempt: 1 }]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["queued", "active", "completed"]);
    expect(events.every((e) => e.jobId === jobId)).toBe(true);
  });

  it("retries failing handlers with growing attempts, then completes", async () => {
    const queue = tracked();
    const attempts: number[] = [];
    queue.register(testJob, async (ctx) => {
      attempts.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error("transient");
    });
    await queue.start();
    await queue.enqueue(testJob, { storeId: STORE_ID, value: 1 });
    expect(await queue.waitForIdle()).toBe(true);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("dead-letters after attempts are exhausted", async () => {
    const queue = tracked();
    const events: JobEvent[] = [];
    queue.onEvent((e) => events.push(e));
    queue.register(testJob, async () => {
      throw new Error("always broken");
    });
    await queue.start();
    await queue.enqueue(testJob, { storeId: STORE_ID, value: 1 });
    expect(await queue.waitForIdle()).toBe(true);
    const dead = events.find((e) => e.type === "dead");
    expect(dead).toBeDefined();
    expect(dead?.attempt).toBe(3);
    expect(dead?.error).toBe("always broken");
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
  });

  it("dead-letters invalid payloads immediately — bad data must not retry", async () => {
    const queue = tracked();
    const events: JobEvent[] = [];
    queue.onEvent((e) => events.push(e));
    let runs = 0;
    queue.register(testJob, () => {
      runs += 1;
      return Promise.resolve();
    });
    await queue.start();
    await expect(
      queue.enqueue(testJob, { storeId: "not-a-uuid", value: 1 } as unknown as TestPayload),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    // Directly injected malformed job (bypasses producer validation) still never runs:
    const internalQueue = queue as unknown as {
      pending: Map<string, unknown>;
      inFlightIds: Set<string>;
    };
    internalQueue.inFlightIds.add("bad-job");
    internalQueue.pending.set("bad-job", {
      jobId: "bad-job",
      name: testJob.name,
      queue: testJob.queue,
      rawPayload: { storeId: 42 },
      attempt: 1,
      maxAttempts: 3,
      backoffBaseMs: 1,
      timeoutMs: 100,
      runAtMs: Date.now(),
    });
    expect(await queue.waitForIdle()).toBe(true);
    expect(runs).toBe(0);
    const badJobEvents = events.filter((e) => e.jobId === "bad-job").map((e) => e.type);
    expect(badJobEvents).toEqual(["active", "dead"]);
  });

  it("dedupes in-flight jobIds and allows re-enqueue after completion", async () => {
    const queue = tracked();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.register(testJob, async () => {
      runs += 1;
      await gate;
    });
    await queue.start();
    await queue.enqueue(testJob, { storeId: STORE_ID, value: 1 }, { jobId: "dedupe-key" });
    // Give the dispatcher a tick, then replay while the first is still active:
    await new Promise((r) => setTimeout(r, 10));
    await queue.enqueue(testJob, { storeId: STORE_ID, value: 1 }, { jobId: "dedupe-key" });
    release();
    expect(await queue.waitForIdle()).toBe(true);
    expect(runs).toBe(1);
    await queue.enqueue(testJob, { storeId: STORE_ID, value: 2 }, { jobId: "dedupe-key" });
    expect(await queue.waitForIdle()).toBe(true);
    expect(runs).toBe(2);
  });

  it("honors enqueue delays", async () => {
    const queue = tracked();
    let ranAt = 0;
    const start = Date.now();
    queue.register(testJob, () => {
      ranAt = Date.now();
      return Promise.resolve();
    });
    await queue.start();
    await queue.enqueue(testJob, { storeId: STORE_ID, value: 1 }, { delayMs: 60 });
    expect(await queue.waitForIdle()).toBe(true);
    expect(ranAt - start).toBeGreaterThanOrEqual(55);
  });

  it("enforces per-attempt timeouts as execution failures", async () => {
    const queue = tracked();
    const events: JobEvent[] = [];
    queue.onEvent((e) => events.push(e));
    queue.register(testJob, () => new Promise<void>((resolve) => setTimeout(resolve, 500)));
    await queue.start();
    await queue.enqueue(testJob, { storeId: STORE_ID, value: 1 });
    expect(await queue.waitForIdle(5_000)).toBe(true);
    expect(events.find((e) => e.type === "dead")?.error).toMatch(/timeout/i);
  });

  it("limits per-queue concurrency", async () => {
    const queue = new MemoryJobQueue({ logger, concurrency: 2, dispatchIntervalMs: 1 });
    queues.push(queue);
    let inFlight = 0;
    let maxInFlight = 0;
    queue.register({ ...testJob, timeoutMs: 2_000 }, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight -= 1;
    });
    await queue.start();
    for (let i = 0; i < 6; i += 1) {
      await queue.enqueue(testJob, { storeId: STORE_ID, value: i });
    }
    expect(await queue.waitForIdle(10_000)).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("fires repeatable schedules until closed", async () => {
    const queue = tracked();
    let ticks = 0;
    queue.register(testJob, () => {
      ticks += 1;
      return Promise.resolve();
    });
    await queue.start();
    await queue.upsertSchedule({
      scheduleId: "tick-test",
      definition: testJob,
      everyMs: 20,
      payload: { storeId: STORE_ID, value: 0 },
    });
    await new Promise((r) => setTimeout(r, 75));
    expect(ticks).toBeGreaterThanOrEqual(2);
    await queue.close();
    const atClose = ticks;
    await new Promise((r) => setTimeout(r, 60));
    expect(ticks).toBe(atClose);
  });

  it("rejects operations after close and surfaces unregistered jobs as dead", async () => {
    const queue = tracked();
    const events: JobEvent[] = [];
    queue.onEvent((e) => events.push(e));
    await queue.close();
    await expect(queue.enqueue(testJob, { storeId: STORE_ID, value: 1 })).rejects.toThrow(/closed/);

    const queue2 = tracked();
    await queue2.start();
    // Enqueue with NO handler registered → dead with a clear error.
    await queue2.enqueue(testJob, { storeId: STORE_ID, value: 1 });
    queue2.onEvent((e) => events.push(e));
    expect(await queue2.waitForIdle()).toBe(true);
    // (listener attached late; verify via second enqueue)
    const events2: JobEvent[] = [];
    queue2.onEvent((e) => events2.push(e));
    await queue2.enqueue(testJob, { storeId: STORE_ID, value: 2 });
    expect(await queue2.waitForIdle()).toBe(true);
    expect(events2.some((e) => e.type === "dead" && e.error?.includes("no handler"))).toBe(true);
  });
});
