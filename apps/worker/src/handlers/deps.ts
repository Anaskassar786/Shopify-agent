import type { CachePort, PubSubPort } from "@profit/cache";
import type { EncryptionService } from "@profit/crypto";
import type { DbClient } from "@profit/db";
import type { Logger } from "@profit/logger";
import type { JobPersistence, JobQueue } from "@profit/queue";
import type { AiProvider, EmailSender } from "@profit/ai";
import type { WorkerEnv } from "../config/env";

/**
 * Shared dependency bundle — constructed once in server.ts (composition
 * root), injected into every handler (P1: DI, modules never self-construct).
 * `aiProvider`/`emailSender` are null when unconfigured — the handlers treat
 * that as a first-class failsafe state (P3), never as a crash.
 */
export interface WorkerDeps {
  readonly env: WorkerEnv;
  readonly logger: Logger;
  readonly db: DbClient;
  readonly queue: JobQueue;
  readonly persistence: JobPersistence;
  readonly cache: CachePort;
  readonly pubsub: PubSubPort;
  readonly encryption: EncryptionService;
  readonly aiProvider: AiProvider | null;
  readonly emailSender: EmailSender | null;
}
