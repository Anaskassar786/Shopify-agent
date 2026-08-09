import type { ProfitDb } from "@profit/db";
import { auditLogs } from "@profit/db";
import type { Logger } from "@profit/logger";
import type { AuditResult } from "@profit/types";

/**
 * Worker-side audit writer — same contract as the API's AuditService (the
 * audit table is platform-level, fire-and-forget semantics, failures logged
 * and swallowed). Kept as a deliberate twin rather than a cross-app import:
 * apps never import from each other (ARCHITECTURE boundary rule); when a
 * third app needs it, the writer graduates into a shared package.
 */
export interface WorkerAuditEvent {
  readonly storeId?: string;
  readonly action: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly result: (typeof AuditResult)[keyof typeof AuditResult];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function recordWorkerAudit(
  db: ProfitDb,
  logger: Logger,
  event: WorkerAuditEvent,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      ...(event.storeId !== undefined ? { storeId: event.storeId } : {}),
      action: event.action,
      ...(event.entityType !== undefined ? { entityType: event.entityType } : {}),
      ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
      result: event.result,
      metadata: (event.metadata ?? {}) as Record<string, unknown>,
    });
  } catch (error) {
    logger.error({ err: error, action: event.action }, "worker.audit.failed");
  }
}
