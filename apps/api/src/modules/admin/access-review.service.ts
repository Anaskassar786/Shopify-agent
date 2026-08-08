import type { ProfitDb } from "@profit/db";
import { and, desc, eq, isNull, sql } from "@profit/db";
import { accessOverrides, platformAdminActions } from "@profit/db";
import { rolePermissions, roles, users, userStoreMemberships } from "@profit/db";
import { stores } from "@profit/db";
import { PlatformAdminAction } from "@profit/types";

/**
 * Access review read-model (M7 SOC-2-lite, ADR 27): answers "who can act on
 * this store, through what role, and which operators touched it recently" —
 * entirely over EXISTING ledgers (memberships/RBAC, access_overrides,
 * platform_admin_actions). No new tables: the review is a projection, so it
 * can never drift from the systems it audits.
 *
 * Cross-tenant by design, same documented exception class as the rest of the
 * admin plane: the api plane constructs this service with the owner client
 * and the router gates it behind X-Platform-Admin-Key.
 */

export interface AccessReviewStore {
  readonly storeId: string;
  readonly name: string;
  readonly shopDomain: string;
  readonly status: string;
  readonly installedAt: string;
  readonly uninstalledAt: string | null;
}

export interface AccessReviewMember {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly roleCode: string;
  readonly permissionCount: number;
  readonly memberSince: string;
  readonly lastLoginAt: string | null;
}

export interface AccessReviewOverride {
  readonly id: string;
  readonly kind: string;
  readonly accessUntil: string;
  readonly grantedBy: string;
  readonly reason: string;
  readonly grantedAt: string;
}

export interface AccessReviewAction {
  readonly id: string;
  readonly operatorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly ip: string | null;
  readonly createdAt: string;
}

/** Sessions are global (storeId null): who held WRITE authority, when, from where. */
export interface OperatorSessionRow {
  readonly operatorId: string;
  readonly ip: string | null;
  readonly createdAt: string;
}

export interface AccessReviewResponse {
  readonly store: AccessReviewStore;
  readonly members: readonly AccessReviewMember[];
  readonly activeOverrides: readonly AccessReviewOverride[];
  /** Store-bound operator actions (trial extensions, overrides, ticket writes). */
  readonly recentActions: readonly AccessReviewAction[];
}

export class AccessReviewService {
  constructor(private readonly db: ProfitDb) {}

  async reviewStore(storeId: string): Promise<AccessReviewResponse | null> {
    const storeRows = await this.db
      .select({
        storeId: stores.id,
        name: stores.name,
        shopDomain: stores.shopDomain,
        status: stores.status,
        installedAt: stores.installedAt,
        uninstalledAt: stores.uninstalledAt,
      })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const store = storeRows[0];
    if (store === undefined) return null;

    const memberRows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
        roleCode: roles.code,
        permissionCount: sql<number>`(select count(*)::int from ${rolePermissions} where ${rolePermissions.roleId} = ${roles.id})`,
        memberSince: userStoreMemberships.createdAt,
        lastLoginAt: users.lastLoginAt,
        deletedAt: users.deletedAt,
      })
      .from(userStoreMemberships)
      .innerJoin(users, eq(userStoreMemberships.userId, users.id))
      .innerJoin(roles, eq(userStoreMemberships.roleId, roles.id))
      .where(eq(userStoreMemberships.storeId, storeId))
      .orderBy(users.email);

    const overrideRows = await this.db
      .select({
        id: accessOverrides.id,
        kind: accessOverrides.kind,
        accessUntil: accessOverrides.accessUntil,
        grantedBy: accessOverrides.grantedBy,
        reason: accessOverrides.reason,
        grantedAt: accessOverrides.createdAt,
      })
      .from(accessOverrides)
      .where(and(eq(accessOverrides.storeId, storeId), isNull(accessOverrides.revokedAt)))
      .orderBy(desc(accessOverrides.accessUntil));

    const actionRows = await this.db
      .select({
        id: platformAdminActions.id,
        operatorId: platformAdminActions.operatorId,
        action: platformAdminActions.action,
        targetType: platformAdminActions.targetType,
        targetId: platformAdminActions.targetId,
        ip: platformAdminActions.ip,
        createdAt: platformAdminActions.createdAt,
      })
      .from(platformAdminActions)
      .where(eq(platformAdminActions.storeId, storeId))
      .orderBy(desc(platformAdminActions.createdAt))
      .limit(25);

    return {
      store: {
        storeId: store.storeId,
        name: store.name,
        shopDomain: store.shopDomain,
        status: store.status,
        installedAt: store.installedAt.toISOString(),
        uninstalledAt: store.uninstalledAt?.toISOString() ?? null,
      },
      members: memberRows
        .filter((row) => row.deletedAt === null)
        .map((row) => ({
          userId: row.userId,
          email: row.email,
          fullName: row.fullName,
          status: row.status,
          roleCode: row.roleCode,
          permissionCount: row.permissionCount,
          memberSince: row.memberSince.toISOString(),
          lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        })),
      activeOverrides: overrideRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        accessUntil: row.accessUntil.toISOString(),
        grantedBy: row.grantedBy,
        reason: row.reason,
        grantedAt: row.grantedAt.toISOString(),
      })),
      recentActions: actionRows.map((row) => ({
        id: row.id,
        operatorId: row.operatorId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Global operator-session ledger (WRITE-authority grants), newest first. */
  async operatorSessions(limit = 50): Promise<readonly OperatorSessionRow[]> {
    const rows = await this.db
      .select({
        operatorId: platformAdminActions.operatorId,
        ip: platformAdminActions.ip,
        createdAt: platformAdminActions.createdAt,
      })
      .from(platformAdminActions)
      .where(eq(platformAdminActions.action, PlatformAdminAction.OpenSession))
      .orderBy(desc(platformAdminActions.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      operatorId: row.operatorId,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
