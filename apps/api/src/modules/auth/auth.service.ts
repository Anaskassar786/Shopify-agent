import { and, eq, execRaw, sql as drizzleSql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  refreshTokens,
  roles,
  sessions,
  shopifySessions,
  stores,
  userStoreMemberships,
  users,
} from "@profit/db";
import { StoreStatus, UserRole } from "@profit/types";
import type { EncryptionService } from "@profit/crypto";
import { AuthenticationError, ForbiddenError } from "../../lib/errors";
import type { Logger } from "@profit/logger";
import { verifyShopifySessionToken } from "../../lib/shopify/session-token";
import type { AuditService } from "../audit/audit.service";
import type { ShopifyOauthService } from "../shopify/oauth.service";
import {
  hashRefreshToken,
  mintRefreshToken,
  type AppAuthClaims,
  type JwtService,
} from "./jwt.service";

/**
 * Merchant authentication (P2: embedded session login, JWT, refresh rotation).
 *
 * Trust chain: App Bridge session token (Shopify-signed) → verified → mapped to
 * a store + JIT-provisioned user → first-party access JWT + rotating refresh.
 * The first human of a store (or Shopify's account_owner) becomes OWNER;
 * everyone else enters as VIEWER until promoted (secure-by-default RBAC, P2).
 */

export interface AuthServiceDeps {
  readonly db: ProfitDb;
  readonly jwt: JwtService;
  readonly oauth: ShopifyOauthService;
  readonly audit: AuditService;
  readonly logger: Logger;
  readonly encryption: EncryptionService;
  readonly shopifyTokenConfig: { apiKey: string; apiSecret: string };
  readonly refreshTtlSeconds: number;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
  readonly user: {
    readonly id: string;
    readonly fullName: string;
    readonly email: string;
    readonly role: string;
  };
  readonly store: { readonly id: string; readonly shopDomain: string; readonly name: string };
}

const ONLINE_TOKEN_FRESHNESS_MS = 5 * 60 * 1000;
const KNOWN_ROLE_CODES: ReadonlySet<string> = new Set<string>(Object.values(UserRole));

function toRoleCode(value: string): (typeof UserRole)[keyof typeof UserRole] {
  return KNOWN_ROLE_CODES.has(value)
    ? (value as (typeof UserRole)[keyof typeof UserRole])
    : UserRole.Viewer;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /** POST /api/v1/auth/session — exchange a Shopify session token for app tokens. */
  async loginWithShopifySession(
    sessionToken: string,
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<LoginResult> {
    const { db, jwt, audit, logger } = this.deps;
    const claims = await verifyShopifySessionToken(sessionToken, this.deps.shopifyTokenConfig);

    const storeRows = await db
      .select()
      .from(stores)
      .where(eq(stores.shopDomain, claims.shopDomain))
      .limit(1);
    const store = storeRows[0];
    if (store === undefined) {
      throw new AuthenticationError("store is not installed — complete OAuth first");
    }
    if (store.status !== StoreStatus.Active) {
      throw new ForbiddenError("store is suspended or uninstalled");
    }

    // Identity enrichment: fresh online token yields the associated user's
    // profile + account_owner flag. Reuse a still-valid token to avoid a
    // token-exchange round trip per login (P6: performance).
    const online = await this.ensureFreshOnlineToken(store.id, claims.shopDomain, sessionToken);

    const { user, roleCode } = await this.resolveUserAndMembership(
      store.id,
      claims.shopifyUserId,
      online.associatedUser,
    );

    await db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const issued = await this.issueTokenPair(user.id, store.id, roleCode, meta);
    await audit.record({
      storeId: store.id,
      userId: user.id,
      action: "authentication.login",
      entityType: "user",
      entityId: user.id,
      result: "SUCCESS",
      ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
      metadata: { via: "shopify_session_token" },
    });
    logger.info({ storeId: store.id, userId: user.id }, "auth.login.success");

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      accessTokenExpiresIn: jwt.accessTtlSeconds,
      user: { id: user.id, fullName: user.fullName, email: user.email, role: roleCode },
      store: { id: store.id, shopDomain: store.shopDomain, name: store.name },
    };
  }

  /** POST /api/v1/auth/refresh — rotate with reuse detection (P2). */
  async rotateRefreshToken(
    presentedRefreshToken: string,
    meta: { ip?: string | undefined },
  ): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiresIn: number }> {
    const { db, jwt, audit, logger } = this.deps;
    const tokenHash = hashRefreshToken(presentedRefreshToken);

    const rows = await db
      .select({
        id: refreshTokens.id,
        userId: refreshTokens.userId,
        sessionId: refreshTokens.sessionId,
        expiresAt: refreshTokens.expiresAt,
        rotatedAt: refreshTokens.rotatedAt,
        revokedAt: refreshTokens.revokedAt,
        sessionStoreId: sessions.storeId,
        sessionRevokedAt: sessions.revokedAt,
      })
      .from(refreshTokens)
      .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    const token = rows[0];
    if (token === undefined) {
      throw new AuthenticationError("refresh token not recognized");
    }

    if (token.rotatedAt !== null || token.revokedAt !== null) {
      // Reuse of a burned token = possible theft: nuke the whole session chain.
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.sessionId, token.sessionId));
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, token.sessionId));
      await audit.record({
        userId: token.userId,
        action: "authentication.refresh_reuse_detected",
        entityType: "session",
        entityId: token.sessionId,
        result: "FAILURE",
        ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
      });
      logger.warn({ sessionId: token.sessionId }, "auth.refresh.reuse_detected");
      throw new AuthenticationError("refresh token reuse detected — session revoked");
    }

    if (token.sessionRevokedAt !== null || token.expiresAt.getTime() < Date.now()) {
      throw new AuthenticationError("refresh token expired or session revoked");
    }
    if (token.sessionStoreId === null) {
      throw new AuthenticationError("session is not store-bound");
    }

    const membership = await this.membershipWithRole(token.userId, token.sessionStoreId);
    const now = new Date();
    await db
      .update(refreshTokens)
      .set({ rotatedAt: now, revokedAt: now })
      .where(eq(refreshTokens.id, token.id));

    const newRefresh = mintRefreshToken();
    await db.insert(refreshTokens).values({
      userId: token.userId,
      sessionId: token.sessionId,
      tokenHash: hashRefreshToken(newRefresh),
      expiresAt: new Date(Date.now() + this.deps.refreshTtlSeconds * 1000),
    });

    const accessToken = await jwt.signAccessToken({
      userId: token.userId,
      sessionId: token.sessionId,
      storeId: token.sessionStoreId,
      role: membership.roleCode,
      permissions: membership.permissions,
    });
    return {
      accessToken,
      refreshToken: newRefresh,
      accessTokenExpiresIn: jwt.accessTtlSeconds,
    };
  }

  /** GET /me — fresh role/permission resolution (claims may lag role changes by ≤TTL). */
  async profileFor(claims: AppAuthClaims) {
    const membership = await this.membershipWithRole(claims.userId, claims.storeId);
    const userRows = await this.deps.db
      .select()
      .from(users)
      .where(eq(users.id, claims.userId))
      .limit(1);
    const user = userRows[0];
    if (user === undefined) throw new AuthenticationError("user no longer exists");
    return {
      user: { id: user.id, email: user.email, fullName: user.fullName, role: membership.roleCode },
      storeId: claims.storeId,
      permissions: membership.permissions,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async ensureFreshOnlineToken(storeId: string, shopDomain: string, sessionToken: string) {
    const { db, encryption, oauth } = this.deps;
    const fresh = await db
      .select()
      .from(shopifySessions)
      .where(
        and(
          eq(shopifySessions.storeId, storeId),
          eq(shopifySessions.sessionType, "ONLINE"),
        ),
      )
      .limit(1);
    const candidate = fresh[0];
    if (
      candidate !== undefined &&
      candidate.expiresAt !== null &&
      candidate.expiresAt.getTime() - Date.now() > ONLINE_TOKEN_FRESHNESS_MS
    ) {
      return { associatedUser: null };
    }

    const exchanged = await oauth.exchangeSessionTokenForOnlineAccess(shopDomain, sessionToken);
    await db
      .insert(shopifySessions)
      .values({
        storeId,
        sessionType: "ONLINE",
        accessTokenEncrypted: encryption.encrypt(exchanged.accessToken),
        scopes: exchanged.scope.split(",").map((s) => s.trim()),
        expiresAt: exchanged.expiresAt,
      })
      .onConflictDoUpdate({
        target: [shopifySessions.storeId, shopifySessions.sessionType],
        set: {
          accessTokenEncrypted: encryption.encrypt(exchanged.accessToken),
          scopes: exchanged.scope.split(",").map((s) => s.trim()),
          expiresAt: exchanged.expiresAt,
          updatedAt: new Date(),
        },
      });
    return { associatedUser: exchanged.associatedUser };
  }

   async resolveUserAndMembership(
    storeId: string,
    shopifyUserId: string,
    associatedUser: {
      id: number;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      accountOwner: boolean;
      locale: string | null;
    } | null,
  ): Promise<{ user: typeof users.$inferSelect; roleCode: (typeof UserRole)[keyof typeof UserRole] }> {
    const { db } = this.deps;

    const known = await db
      .select()
      .from(users)
      .where(eq(users.shopifyUserId, shopifyUserId))
      .limit(1);
    const user = known[0] !== undefined
      ? await this.touchProfile(known[0], associatedUser)
      : await this.createShopifyUser(shopifyUserId, associatedUser);

    const membershipRows = await db
      .select({ roleId: userStoreMemberships.roleId })
      .from(userStoreMemberships)
      .where(
        and(
          eq(userStoreMemberships.userId, user.id),
          eq(userStoreMemberships.storeId, storeId),
        ),
      )
      .limit(1);

    const ownerRole = await this.roleByCode(UserRole.Owner);
    const accountOwner = associatedUser?.accountOwner === true;

    if (membershipRows[0] === undefined) {
      const storeMemberships = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(userStoreMemberships)
        .where(eq(userStoreMemberships.storeId, storeId));
      const isFirstMember = (storeMemberships[0]?.count ?? 0) === 0;
      const assignedRole = accountOwner || isFirstMember
        ? ownerRole
        : await this.roleByCode(UserRole.Viewer);
      await db.insert(userStoreMemberships).values({
        userId: user.id,
        storeId,
        roleId: assignedRole.id,
      });
      return { user, roleCode: assignedRole.code };
    }

    if (accountOwner && membershipRows[0].roleId !== ownerRole.id) {
      await db
        .update(userStoreMemberships)
        .set({ roleId: ownerRole.id })
        .where(
          and(
            eq(userStoreMemberships.userId, user.id),
            eq(userStoreMemberships.storeId, storeId),
          ),
        );
      return { user, roleCode: UserRole.Owner };
    }

    const roleRows = await db.select().from(roles).where(eq(roles.id, membershipRows[0].roleId)).limit(1);
    const role = roleRows[0];
    return { user, roleCode: (role?.code ?? UserRole.Viewer) as (typeof UserRole)[keyof typeof UserRole] };
  }

  private async touchProfile(
    user: typeof users.$inferSelect,
    associatedUser: { email: string | null; firstName: string | null; lastName: string | null } | null,
  ): Promise<typeof users.$inferSelect> {
    if (associatedUser === null) return user;
    const fullName = [associatedUser.firstName, associatedUser.lastName]
      .filter((part): part is string => part !== null && part !== "")
      .join(" ");
    const updates: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (fullName !== "" && fullName !== user.fullName) updates.fullName = fullName;
    if (associatedUser.email !== null && associatedUser.email.toLowerCase() !== user.email.toLowerCase()) {
      updates.email = associatedUser.email.toLowerCase();
    }
    if (Object.keys(updates).length === 1) return user;
    const updated = await this.deps.db
      .update(users)
      .set(updates)
      .where(eq(users.id, user.id))
      .returning();
    return updated[0] ?? user;
  }

  private async createShopifyUser(
    shopifyUserId: string,
    associatedUser: { email: string | null; firstName: string | null; lastName: string | null } | null,
  ): Promise<typeof users.$inferSelect> {
    const fullName =
      associatedUser === null
        ? "Shopify Merchant"
        : [associatedUser.firstName, associatedUser.lastName]
            .filter((part): part is string => part !== null && part !== "")
            .join(" ") || "Shopify Merchant";
    const email = associatedUser?.email?.toLowerCase() ?? `${shopifyUserId}@shopify-user.unresolved`;
    const created = await this.deps.db
      .insert(users)
      .values({ shopifyUserId, email, fullName, status: "ACTIVE" })
      .onConflictDoUpdate({
        // shopify_user_id unique index is PARTIAL (WHERE IS NOT NULL) — Postgres
        // requires the same predicate in the arbiter for ON CONFLICT to match.
        target: users.shopifyUserId,
        targetWhere: drizzleSql`${users.shopifyUserId} IS NOT NULL`,
        set: { updatedAt: new Date() },
      })
      .returning();
    const row = created[0];
    if (row === undefined) throw new AuthenticationError("user provisioning failed");
    return row;
  }

  private async roleByCode(code: (typeof UserRole)[keyof typeof UserRole]) {
    const rows = await this.deps.db.select().from(roles).where(eq(roles.code, code)).limit(1);
    const role = rows[0];
    if (role === undefined) {
      throw new AuthenticationError(`role catalog not seeded (${code})`);
    }
    return role;
  }

  private async membershipWithRole(userId: string, storeId: string) {
    const rows = await execRaw<{
      role_code: string;
      permissions: string[];
    }>(
      this.deps.db,
      drizzleSql`
      SELECT r.code AS role_code,
             COALESCE(array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
      FROM user_store_memberships m
      JOIN roles r ON r.id = m.role_id
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE m.user_id = ${userId} AND m.store_id = ${storeId}
      GROUP BY r.code
      LIMIT 1
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new ForbiddenError("no membership for this store");
    }
    return { roleCode: toRoleCode(row.role_code), permissions: row.permissions ?? [] };
  }

  private async issueTokenPair(
    userId: string,
    storeId: string,
    roleCode: (typeof UserRole)[keyof typeof UserRole],
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ) {
    const { db, jwt } = this.deps;
    const sessionRows = await db
      .insert(sessions)
      .values({
        userId,
        storeId,
        ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
        ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
        expiresAt: new Date(Date.now() + this.deps.refreshTtlSeconds * 1000),
      })
      .returning({ id: sessions.id });
    const session = sessionRows[0];
    if (session === undefined) throw new AuthenticationError("session creation failed");

    const membership = await this.membershipWithRole(userId, storeId);
    const refreshToken = mintRefreshToken();
    await db.insert(refreshTokens).values({
      userId,
      sessionId: session.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + this.deps.refreshTtlSeconds * 1000),
    });

    const accessToken = await jwt.signAccessToken({
      userId,
      sessionId: session.id,
      storeId,
      role: membership.roleCode === roleCode ? roleCode : membership.roleCode,
      permissions: membership.permissions,
    });
    return { accessToken, refreshToken };
  }
}
