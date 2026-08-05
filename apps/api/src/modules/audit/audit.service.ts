import type { ProfitDb } from "@profit/db";
import { auditLogs } from "@profit/db";
import type { AuditResult } from "@profit/types";
import type { Logger } from "@profit/logger";

/**
 * Audit writer (P2/P5: audit-ready pipeline). Fire-and-forget semantics are
 * deliberate: audit failure must never break the audited user action, so
 * failures log+swallow with a security-level warning. For actions where audit
 * integrity is itself the requirement (auth, billing) callers may await and
 * escalate instead — both modes are supported here.
 */

export interface AuditEvent {
  readonly storeId?: string;
  readonly userId?: string;
  readonly action: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly result: (typeof AuditResult)[keyof typeof AuditResult];
  readonly ip?: string;
  readonly userAgent?: string;
  /** Pre-redacted, client-safe context. Never pass secrets/tokens (P5). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class AuditService {
  constructor(
    private readonly db: ProfitDb,
    private readonly logger: Logger,
  ) {}

  /** Awaited write — callers that need the guarantee use this. */
  async record(event: AuditEvent): Promise<void> {
    try {
      await this.db.insert(auditLogs).values(this.toRow(event));
    } catch (error) {
      this.logger.error(
        { err: error, action: event.action },
        "audit.record.failed",
      );
    }
  }

  /** Detached write for hot paths. */
  recordDetached(event: AuditEvent): void {
    void this.record(event);
  }

  private toRow(event: AuditEvent) {
    return {
      ...(event.storeId !== undefined ? { storeId: event.storeId } : {}),
      ...(event.userId !== undefined ? { userId: event.userId } : {}),
      action: event.action,
      ...(event.entityType !== undefined ? { entityType: event.entityType } : {}),
      ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
      result: event.result,
      ...(event.ip !== undefined ? { ip: event.ip } : {}),
      ...(event.userAgent !== undefined ? { userAgent: event.userAgent } : {}),
      metadata: (event.metadata ?? {}) as Record<string, unknown>,
    };
  }
}
