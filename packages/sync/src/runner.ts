import { and, desc, eq, inArray, isNotNull } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { shopifySessions, stores, syncHistory } from "@profit/db";
import type { EncryptionService } from "@profit/crypto";
import type { Logger } from "@profit/logger";
import { StoreStatus, SyncMode, SyncStatus, type SyncModule } from "@profit/types";
import type { ShopifyHttpOptions } from "@profit/shopify";
import { SYNC_MODULES } from "./modules/index";
import type { WriteStats } from "./writers";
import {
  OfflineCredentialService,
  type OfflineCredential,
} from "./credentials/offline-credential.service";

/**
 * Sync run lifecycle (P2 sync engine: "logs every sync run", "resumable").
 * State machine per (store, module): PENDING → RUNNING → COMPLETED | FAILED;
 * a FULL run that dies mid-pagination resumes from its stored page_info
 * cursor — upsert idempotency makes replayed pages harmless, and the cursor
 * guarantees bounded re-work. Stats accumulate per page, so stalls are
 * visible in sync_history within seconds instead of at the end.
 */

export interface SyncRunRequest {
  readonly storeId: string;
  readonly module: SyncModule;
  readonly mode: (typeof SyncMode)[keyof typeof SyncMode];
  readonly runGroupId?: string | undefined;
}

export interface SyncRunnerDeps {
  readonly db: ProfitDb;
  readonly encryption: EncryptionService;
  readonly apiVersion: string;
  readonly logger: Logger;
  /** Transport budget knobs (P5: retries are config, not constants). */
  readonly httpOptions?: ShopifyHttpOptions | undefined;
  /** Centralized OFFLINE credential service (expiring token + refresh).
   * When present, resolveStoreAdminContext delegates to it for fresh tokens.
   */
  readonly offlineCredentialService?: OfflineCredentialService | undefined;
}

export class SyncConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncConfigurationError";
  }
}

interface ResumableRun {
  readonly id: string;
  readonly cursor: string | null;
  readonly stats: WriteStats;
}

/** Latest unfinished FULL run with a cursor checkpoint = resume target. */
async function findResumableRun(
  db: ProfitDb,
  storeId: string,
  module: SyncModule,
): Promise<ResumableRun | null> {
  const rows = await db
    .select()
    .from(syncHistory)
    .where(
      and(
        eq(syncHistory.storeId, storeId),
        eq(syncHistory.module, module),
        eq(syncHistory.mode, SyncMode.Full),
        inArray(syncHistory.status, [SyncStatus.Running, SyncStatus.Failed]),
        isNotNull(syncHistory.cursor),
      ),
    )
    .orderBy(desc(syncHistory.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.cursor === null) return null;
  const rawStats = row.stats as Partial<WriteStats> | null;
  return {
    id: row.id,
    cursor: row.cursor,
    stats: {
      processed: rawStats?.processed ?? 0,
      created: rawStats?.created ?? 0,
      updated: rawStats?.updated ?? 0,
      failed: rawStats?.failed ?? 0,
    },
  };
}

export interface ResolvedAdminContext {
  readonly shopDomain: string;
  readonly accessToken: string;
}

/**
 * Resolve a store's OFFLINE credential (expiring or non-expiring) into a working
 * admin context. Delegates to OfflineCredentialService when provided so that
 * expiring offline tokens are refreshed transparently before use.
 *
 * This is the SINGLE path for all background/sync/webhook/billing/admin API calls
 * that need an OFFLINE token. Never bypass it with raw DB decrypt.
 */
export async function resolveStoreAdminContext(
  db: ProfitDb,
  encryption: EncryptionService,
  storeId: string,
  offlineCredentialService?: OfflineCredentialService,
): Promise<ResolvedAdminContext> {
  // Preferred path: use centralized service (handles expiry + refresh + atomic persist)
  if (offlineCredentialService) {
    const cred: OfflineCredential = await offlineCredentialService.getValidAccessToken(storeId);
    return {
      shopDomain: cred.shopDomain,
      accessToken: cred.accessToken,
    };
  }

  // Legacy / fallback direct path (should only be used in tests or during migration wiring).
  // In production composition roots this path should be eliminated.
  const storeRows = await db
    .select({ id: stores.id, shopDomain: stores.shopDomain, status: stores.status })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  const store = storeRows[0];
  if (store === undefined) throw new SyncConfigurationError(`store ${storeId} not found`);
  if (store.status !== StoreStatus.Active) {
    throw new SyncConfigurationError(`store ${storeId} is not active (status ${store.status})`);
  }
  const sessionRows = await db
    .select({ accessTokenEncrypted: shopifySessions.accessTokenEncrypted })
    .from(shopifySessions)
    .where(and(eq(shopifySessions.storeId, storeId), eq(shopifySessions.sessionType, "OFFLINE")))
    .limit(1);
  const session = sessionRows[0];
  if (session === undefined) {
    throw new SyncConfigurationError(`store ${storeId} has no offline Shopify session`);
  }
  return {
    shopDomain: store.shopDomain,
    accessToken: encryption.decrypt(session.accessTokenEncrypted),
  };
}

export interface SyncRunOutcome {
  readonly status: "completed";
  readonly stats: WriteStats;
  readonly resumedFromCursor: string | null;
  readonly durationMs: number;
  /** sync_history row — the durable record of this run. */
  readonly runId: string;
}

/** Execute one module sync with full checkpoint bookkeeping. */
export async function runModuleSync(
  deps: SyncRunnerDeps,
  request: SyncRunRequest,
): Promise<SyncRunOutcome> {
  const startedAt = Date.now();
  const impl = SYNC_MODULES[request.module];
  const { shopDomain, accessToken } = await resolveStoreAdminContext(
    deps.db,
    deps.encryption,
    request.storeId,
    deps.offlineCredentialService,
  );

  // Provide a single-use refresh hook (bound to this store + service) for 401 recovery.
  // The HTTP layer (via ShopifyAdminContext) will call it at most once on 401.
  const refreshAccessToken = deps.offlineCredentialService
    ? async () => {
        const cred = await deps.offlineCredentialService!.getValidAccessToken(request.storeId);
        return cred.accessToken;
      }
    : undefined;
  const logger = deps.logger.child({ storeId: request.storeId, module: request.module });

  const resume =
    request.mode === SyncMode.Full ? await findResumableRun(deps.db, request.storeId, request.module) : null;

  let runId: string;
  const stats: WriteStats = resume?.stats ?? { processed: 0, created: 0, updated: 0, failed: 0 };

  if (resume !== null) {
    runId = resume.id;
    await deps.db
      .update(syncHistory)
      .set({ status: SyncStatus.Running, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(syncHistory.id, runId));
    logger.info({ runId, cursor: resume.cursor }, "sync.run.resumed");
  } else {
    const inserted = await deps.db
      .insert(syncHistory)
      .values({
        storeId: request.storeId,
        module: request.module,
        mode: request.mode,
        status: SyncStatus.Running,
        startedAt: new Date(),
        ...(request.runGroupId !== undefined ? { runGroupId: request.runGroupId } : {}),
        stats,
      })
      .returning({ id: syncHistory.id });
    const row = inserted[0];
    if (row === undefined) throw new Error("failed to open sync run row");
    runId = row.id;
    logger.info({ runId }, "sync.run.started");
  }

  // Overlapping watermark (started_at of the last completed run, minus a
  // one-minute safety margin): replaying a few already-synced rows is
  // idempotent by design, while a gap would be permanent data loss.
  let lastIncrementalWatermark: Date | null = null;
  if (request.mode === SyncMode.Incremental) {
    const completed = await deps.db
      .select({ startedAt: syncHistory.startedAt })
      .from(syncHistory)
      .where(
        and(
          eq(syncHistory.storeId, request.storeId),
          eq(syncHistory.module, request.module),
          eq(syncHistory.status, SyncStatus.Completed),
        ),
      )
      .orderBy(desc(syncHistory.finishedAt))
      .limit(1);
    const started = completed[0]?.startedAt ?? null;
    lastIncrementalWatermark =
      started !== null ? new Date(started.getTime() - 60_000) : null;
  }

  const checkpoint = {
    async pageComplete(cursor: string | null, delta: WriteStats): Promise<void> {
      stats.processed += delta.processed;
      stats.created += delta.created;
      stats.updated += delta.updated;
      stats.failed += delta.failed;
      await deps.db
        .update(syncHistory)
        .set({ cursor, stats: { ...stats }, updatedAt: new Date() })
        .where(eq(syncHistory.id, runId));
    },
  };

  try {
    await impl.sync({
      db: deps.db,
      storeId: request.storeId,
      shopDomain,
      accessToken,
      apiVersion: deps.apiVersion,
      logger,
      mode: request.mode,
      resumeCursor: resume?.cursor ?? null,
      lastIncrementalWatermark,
      checkpoint,
      ...(deps.httpOptions !== undefined ? { httpOptions: deps.httpOptions } : {}),
      ...(refreshAccessToken ? { refreshAccessToken } : {}),
    });
    await deps.db
      .update(syncHistory)
      .set({
        status: SyncStatus.Completed,
        cursor: null,
        stats: { ...stats },
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(syncHistory.id, runId));
    logger.info({ runId, stats, durationMs: Date.now() - startedAt }, "sync.run.completed");
    return {
      status: "completed",
      stats: { ...stats },
      resumedFromCursor: resume?.cursor ?? null,
      durationMs: Date.now() - startedAt,
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, runId }, "sync.run.failed");
    const runRows = await deps.db
      .select({ cursor: syncHistory.cursor, retryCount: syncHistory.retryCount })
      .from(syncHistory)
      .where(eq(syncHistory.id, runId))
      .limit(1);
    await deps.db
      .update(syncHistory)
      .set({
        status: SyncStatus.Failed,
        errorMessage: message,
        retryCount: (runRows[0]?.retryCount ?? 0) + 1,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(syncHistory.id, runId));
    throw error;
  }
}
