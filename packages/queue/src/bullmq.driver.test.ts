import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger } from "@profit/logger";
import { QueueName } from "@profit/types";
import { BullMqJobQueue } from "./bullmq.driver";
import type { JobDefinition } from "./port";

/**
 * BullMQ driver integration — ONly runs where a real Redis exists (CI: Redis
 * service container; local: docker compose). The sandbox has no Redis, so the
 * suite self-skips; everything except the transport itself is covered by the
 * driver-agnostic MemoryJobQueue suite (identical port semantics).
 */

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: "fatal", service: "bullmq-test", environment: "test", destination: sink });

const REDIS_URL = process.env["REDIS_URL"];
const suite = REDIS_URL === undefined ? describe.skip : describe;

const job: JobDefinition<{ n: number }> = {
  name: "ci.bullmq.echo",
  queue: QueueName.Cleanup,
  schema: z.object({ n: z.number().int() }),
  attempts: 2,
  backoffBaseMs: 50,
  timeoutMs: 2_000,
};

suite("BullMqJobQueue (real Redis)", () => {
  it("executes jobs and emits completed events", async () => {
    const queue = new BullMqJobQueue({
      logger,
      connection: { url: REDIS_URL ?? "", maxRetriesPerRequest: null },
      concurrency: 2,
      queuePrefix: `test-${String(Date.now())}`,
    });
    const seen: number[] = [];
    queue.register(job, async (ctx) => {
      seen.push(ctx.payload.n);
    });
    await queue.start();
    await queue.enqueue(job, { n: 1 });
    expect(await queue.waitForIdle(10_000)).toBe(true);
    expect(seen).toEqual([1]);
    await queue.close();
  }, 20_000);

  it("retries then dead-letters", async () => {
    const queue = new BullMqJobQueue({
      logger,
      connection: { url: REDIS_URL ?? "", maxRetriesPerRequest: null },
      concurrency: 1,
      queuePrefix: `test-${String(Date.now())}-dead`,
    });
    const events: string[] = [];
    queue.onEvent((e) => events.push(e.type));
    queue.register(job, () => Promise.reject(new Error("ci-forced-failure")));
    await queue.start();
    await queue.enqueue(job, { n: 2 });
    await expect(queue.waitForIdle(15_000)).resolves.toBe(true);
    // waitForIdle reflects queue emptiness; final event flush is async — give a beat.
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toContain("dead");
    await queue.close();
  }, 25_000);
});
