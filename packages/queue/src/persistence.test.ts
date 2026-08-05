import { Writable } from "node:stream";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { backgroundJobs, failedJobs, jobRetries, stores } from "@profit/db";
import { createTestDatabase, type TestDatabase } from "@profit/db/testing";
import { createLogger } from "@profit/logger";
import { QueueName } from "@profit/types";
import { MemoryJobQueue } from "./memory.driver";
import { JobPersistence } from "./persistence";
import type { JobDefinition } from "./port";
import { createJobQueue } from "./factory";
import { BullMqJobQueue } from "./bullmq.driver";

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: "fatal", service: "queue-persistence-test", environment: "test", destination: sink });

let testDb: TestDatabase;
let db: ProfitDb;
let storeId: string;

const flakyJob: JobDefinition<{ storeId: string; failTimes: number }> = {
  name: "test.flaky",
  queue: QueueName.Analytics,
  schema: z.object({ storeId: z.string().uuid(), failTimes: z.number().int() }),
  attempts: 3,
  backoffBaseMs: 1,
  timeoutMs: 500,
};

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  testDb = await createTestDatabase(resolve(here, "../../../packages/db/drizzle"));
  db = testDb.db;
  const inserted = await db
    .insert(stores)
    .values({ shopDomain: "queue-persist.myshopify.com", name: "Queue Persist" })
    .returning({ id: stores.id });
  storeId = inserted[0]!.id;
});

afterAll(async () => {
  await testDb.close();
});

describe("JobPersistence", () => {
  it("mirrors the full lifecycle into background_jobs / job_retries / failed_jobs", async () => {
    const queue = new MemoryJobQueue({ logger, dispatchIntervalMs: 2 });
    const persistence = new JobPersistence(db, logger);
    persistence.attach(queue);

    let executions = 0;
    queue.register(flakyJob, async () => {
      executions += 1;
      throw new Error("boom");
    });
    await queue.start();

    const jobId = "persist-job-1";
    await persistence.enqueuePersistent(queue, flakyJob, { storeId, failTimes: 99 }, { jobId });
    expect(await queue.waitForIdle()).toBe(true);
    // Give the (async) event persistence a beat.
    await new Promise((r) => setTimeout(r, 50));
    await queue.close();

    const rows = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.idempotencyKey, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("DEAD_LETTERED");
    expect(rows[0]?.attempts).toBe(3);
    expect(rows[0]?.storeId).toBe(storeId);
    expect(rows[0]?.lastError).toBe("boom");

    const retries = await db.select().from(jobRetries).where(eq(jobRetries.jobId, rows[0]!.id));
    expect(retries).toHaveLength(2);

    const dead = await db.select().from(failedJobs).where(eq(failedJobs.queue, QueueName.Analytics));
    expect(dead.some((f) => f.jobType === flakyJob.name && f.attemptsMade === 3)).toBe(true);
    expect(executions).toBe(3);
  });

  it("records QUEUED once per idempotency key; replay is a no-op", async () => {
    const persistence = new JobPersistence(db, logger);
    const first = await persistence.recordQueued(flakyJob, "idem-key-1", { storeId, failTimes: 0 });
    const second = await persistence.recordQueued(flakyJob, "idem-key-1", { storeId, failTimes: 0 });
    expect(first).toBe("inserted");
    expect(second).toBe("duplicate");
    const rows = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.idempotencyKey, "idem-key-1"));
    expect(rows).toHaveLength(1);
  });

  it("marks completed jobs cleanly through the event path", async () => {
    const queue = new MemoryJobQueue({ logger, dispatchIntervalMs: 2 });
    const persistence = new JobPersistence(db, logger);
    persistence.attach(queue);
    queue.register(flakyJob, () => Promise.resolve());
    await queue.start();
    await persistence.enqueuePersistent(queue, flakyJob, { storeId, failTimes: 0 }, { jobId: "complete-key" });
    expect(await queue.waitForIdle()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    await queue.close();
    const rows = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.idempotencyKey, "complete-key"));
    expect(rows[0]?.status).toBe("COMPLETED");
    expect(rows[0]?.finishedAt).not.toBeNull();
  });
});

describe("createJobQueue", () => {
  it("selects the in-process driver when REDIS_URL is absent", () => {
    const queue = createJobQueue({ logger });
    expect(queue).toBeInstanceOf(MemoryJobQueue);
    return queue.close();
  });

  it("selects BullMQ when REDIS_URL is present (connection established lazily in tests)", async () => {
    const queue = createJobQueue({ logger, redisUrl: "redis://127.0.0.1:6390" });
    expect(queue).toBeInstanceOf(BullMqJobQueue);
    await queue.close();
  });
});
