import type { CachePort, PubSubPort } from "@profit/cache";
import type { EncryptionService } from "@profit/crypto";
import type { DbClient } from "@profit/db";
import type { Logger } from "@profit/logger";
import type { JobPersistence, JobQueue } from "@profit/queue";
import type { AiProvider, EmailSender } from "@profit/ai";
import type { SmsSender } from "@profit/automation";
import type { WorkerEnv } from "../config/env";
import type { OfflineCredentialService } from "@profit/sync";

/**
 * Shared dependency bundle — constructed once in server.ts (composition
 * root), injected into every handler (P1: DI, modules never self-construct).
 * `aiProvider`/`emailSender`/`smsSender` are null when unconfigured — the
 * handlers treat that as a first-class failsafe state (P3), never as a crash.
 * M6 pieces carrying secrets (tracking HMAC key, public tracking base URL)
 * are scalar values, so handlers never reach into `env` for them (mirrors
 * how `encryption` is surfaced).
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
  /** M6: Twilio adapter — null means the SMS channel reports itself unavailable. */
  readonly smsSender: SmsSender | null;
  /** M6: HMAC key for open/click/unsubscribe tracking tokens (null disables tracked links). */
  readonly trackingSecret: string | null;
  /** M6: public base URL embedded in generated tracking links (API origin). */
  readonly trackingBaseUrl: string;

  /** Centralized OFFLINE Shopify credential service (expiring tokens + refresh).
   * Injected from composition root. All token access MUST go through this.
   */
  readonly offlineCredentialService?: OfflineCredentialService | undefined;
}
