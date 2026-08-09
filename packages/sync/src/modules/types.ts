import type { ProfitDb } from "@profit/db";
import type { ShopifyHttpOptions } from "@profit/shopify";
import type { Logger } from "@profit/logger";
import type { SyncMode, SyncModule } from "@profit/types";
import type { WriteStats } from "../writers";

/**
 * Sync module contract — seven implementations (P2: products, customers,
 * orders, inventory, collections, discounts, metafields). A module ONLY knows
 * how to stream its resource pages into writers; run lifecycle (checkpoints,
 * resume, status) lives in runner.ts; job wiring lives in apps/worker.
 */

export interface PageCheckpoint {
  /** Persist stats + the cursor for the NEXT page (null = last page reached). */
  pageComplete(cursor: string | null, delta: WriteStats): Promise<void>;
}

export interface SyncModuleContext {
  readonly db: ProfitDb;
  readonly storeId: string;
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly apiVersion: string;
  readonly logger: Logger;
  readonly mode: (typeof SyncMode)[keyof typeof SyncMode];
  /** page_info cursor to resume from (FULL runs only). */
  readonly resumeCursor: string | null;
  /** Server-side `updated_at_min` filter for INCREMENTAL runs (overlapping watermark). */
  readonly lastIncrementalWatermark: Date | null;
  readonly checkpoint: PageCheckpoint;
  readonly httpOptions?: ShopifyHttpOptions | undefined;
}

export interface SyncModuleImpl {
  readonly id: SyncModule;
  sync(ctx: SyncModuleContext): Promise<void>;
}

export class ModuleSyncError extends Error {
  constructor(module: SyncModule, message: string, cause?: unknown) {
    super(`${module} sync failed: ${message}`);
    this.name = "ModuleSyncError";
    this.cause = cause;
  }
}
