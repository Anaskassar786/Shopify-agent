import type { Logger } from "@profit/logger";
import { BullMqJobQueue } from "./bullmq.driver";
import { MemoryJobQueue } from "./memory.driver";
import type { JobQueue } from "./port";

/**
 * Driver selection (P12 scale plan): Redis present → BullMQ for the real
 * multi-process topology; absent → the in-process driver (tests, tiny
 * single-process deployments). This is a deployment decision, never a
 * code branch inside business logic.
 */
export interface JobQueueFactoryOptions {
  readonly logger: Logger;
  readonly redisUrl?: string | undefined;
  readonly concurrency?: number;
}

export function createJobQueue(options: JobQueueFactoryOptions): JobQueue {
  if (options.redisUrl !== undefined && options.redisUrl !== "") {
    return new BullMqJobQueue({
      logger: options.logger,
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    });
  }
  options.logger.warn(
    "REDIS_URL not configured — using in-process queue driver (single-process mode)",
  );
  return new MemoryJobQueue({
    logger: options.logger,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
  });
}
