import { and, desc, eq, gt, isNull, sql, withStoreScope, accessOverrides, stores } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import type { AccessOverrideKind } from "@profit/types";

/**
 * AccessOverrideService (M6, from the M5 deferred list): support-granted
 * comped-access windows. An ACTIVE override (not revoked, access_until in
 * the future) bypasses ONLY the subscription-status gate — plan quotas keep
 * applying from the store's own plan. Grants/revokes happen exclusively from
 * the platform-admin module, which simultaneously ledgers every call into
 * platform_admin_actions (operator identity + payload hash).
 */

export class AccessOverrideNotFoundError extends Error {
  constructor(id: string) {
    super(`access override ${id} not found`);
    this.name = "AccessOverrideNotFoundError";
  }
}

export class AccessOverrideStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessOverrideStateError";
  }
}

export interface AccessOverrideRow {
  readonly id: string;
  readonly storeId: string;
  readonly kind: (typeof AccessOverrideKind)[keyof typeof AccessOverrideKind];
  readonly accessUntil: Date;
  readonly reason: string;
  readonly grantedBy: string;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly createdAt: Date;
}

export const ACCESS_OVERRIDE_LIMITS = {
  maxWindowDays: 90,
  reasonMax: 500,
} as const;

export class AccessOverrideService {
  constructor(private readonly db: ProfitDb) {}

  async grant(
    storeId: string,
    input: { kind: (typeof AccessOverrideKind)[keyof typeof AccessOverrideKind]; accessUntil: Date; reason: string; grantedBy: string },
    now = new Date(),
  ): Promise<AccessOverrideRow> {
    if (input.accessUntil.getTime() <= now.getTime()) {
      throw new AccessOverrideStateError("accessUntil must be in the future");
    }
    const maxUntil = new Date(now.getTime() + ACCESS_OVERRIDE_LIMITS.maxWindowDays * 86_400_000);
    if (input.accessUntil.getTime() > maxUntil.getTime()) {
      throw new AccessOverrideStateError(`override window cannot exceed ${ACCESS_OVERRIDE_LIMITS.maxWindowDays} days`);
    }
    if (input.reason.trim().length === 0 || input.reason.length > ACCESS_OVERRIDE_LIMITS.reasonMax) {
      throw new AccessOverrideStateError("a reason of 1..500 characters is required for the audit record");
    }
    const storeRows = await this.db.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).limit(1);
    if (storeRows[0] === undefined) throw new AccessOverrideStateError("store not found");
    const rows = await this.db
      .insert(accessOverrides)
      .values({
        storeId,
        kind: input.kind,
        accessUntil: input.accessUntil,
        reason: input.reason,
        grantedBy: input.grantedBy,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new AccessOverrideStateError("override insert returned no row");
    return this.toRow(row);
  }

  async revoke(
    storeId: string,
    overrideId: string,
    input: { revokedBy: string; reason: string },
    now = new Date(),
  ): Promise<AccessOverrideRow> {
    if (input.reason.trim().length === 0 || input.reason.length > ACCESS_OVERRIDE_LIMITS.reasonMax) {
      throw new AccessOverrideStateError("a revoke reason is required for the audit record");
    }
    const updated = await this.db
      .update(accessOverrides)
      .set({ revokedAt: now, revokedBy: input.revokedBy, revokeReason: input.reason, updatedAt: now })
      .where(
        and(
          eq(accessOverrides.id, overrideId),
          eq(accessOverrides.storeId, storeId),
          isNull(accessOverrides.revokedAt),
        ),
      )
      .returning();
    const row = updated[0];
    if (row === undefined) {
      throw new AccessOverrideNotFoundError(overrideId);
    }
    return this.toRow(row);
  }

  /** The override currently unlocking the store, if any (gate integration). */
  async findActiveForStore(storeId: string, now = new Date()): Promise<AccessOverrideRow | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(accessOverrides)
        .where(
          and(
            eq(accessOverrides.storeId, storeId),
            isNull(accessOverrides.revokedAt),
            gt(accessOverrides.accessUntil, now),
          ),
        )
        .orderBy(desc(accessOverrides.accessUntil))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : this.toRow(row);
    });
  }

  /** Full history for one store (admin merchant detail). Owner role. */
  async listForStore(storeId: string): Promise<readonly AccessOverrideRow[]> {
    const rows = await this.db
      .select()
      .from(accessOverrides)
      .where(eq(accessOverrides.storeId, storeId))
      .orderBy(desc(accessOverrides.createdAt));
    return rows.map((r) => this.toRow(r));
  }

  /** Stores with a currently-active override (admin dashboard badge). Owner role. */
  async countActiveStores(now = new Date()): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`count(distinct ${accessOverrides.storeId})::int` })
      .from(accessOverrides)
      .where(and(isNull(accessOverrides.revokedAt), gt(accessOverrides.accessUntil, now)));
    return rows[0]?.total ?? 0;
  }

  private toRow(row: typeof accessOverrides.$inferSelect): AccessOverrideRow {
    const { updatedAt: _updatedAt, ...rest } = row;
    return rest;
  }
}
