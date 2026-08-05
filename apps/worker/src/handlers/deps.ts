import type { CachePort } from "@profit/cache";
import type { EncryptionService } from "@profit/crypto";
import type { DbClient } from "@profit/db";
import type { Logger } from "@profit/logger";
import type { JobPersistence, JobQueue } from "@profit/queue";
import type { WorkerEnv } from "../config/env";

/**
 * Shared dependency bundle — constructed once in server.ts (composition
 * root), injected into every handler (P1: DI, modules never self-construct).
 */
export interface WorkerDeps {
  readonly env: WorkerEnv;
  readonly logger: Logger;
  readonly db: DbClient;
  readonly queue: JobQueue;
  readonly persistence: JobPersistence;
  readonly cache: CachePort;
  readonly encryption: EncryptionService;
}
