import { sql } from "drizzle-orm";
import {
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { UserRole, UserStatus } from "@profit/types";
import { baseColumns, enumToPgTuple, softDeleteColumns } from "./_common";
import { stores } from "./merchant";

export const userStatusEnum = pgEnum("user_status", enumToPgTuple(UserStatus));
export const userRoleEnum = pgEnum("user_role", enumToPgTuple(UserRole));

/**
 * Platform identities (the humans logging in). A user may belong to MANY stores
 * (agencies, multi-store merchants — P8), so the user itself is NOT tenant-scoped;
 * tenant scoping happens through `user_store_memberships`.
 */
export const users = pgTable(
  "users",
  {
    ...baseColumns,
    ...softDeleteColumns,
    email: varchar("email", { length: 320 }).notNull(),
    /** Null for identities that only authenticate via Shopify session tokens. */
    passwordHash: text("password_hash"),
    /**
     * Shopify user id from the embedded session token (`sub`). Established by
     * JIT provisioning on first embedded request; stable across reinstalls.
     */
    shopifyUserId: varchar("shopify_user_id", { length: 64 }),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(sql`lower(${table.email})`),
    uniqueIndex("users_shopify_user_unique")
      .on(table.shopifyUserId)
      .where(sql`${table.shopifyUserId} is not null`),
  ],
);

/** RBAC catalog (P2/P12). Permissions seeded from code; roles composable per store. */
export const roles = pgTable(
  "roles",
  {
    ...baseColumns,
    code: userRoleEnum("code").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 500 }),
  },
  (table) => [uniqueIndex("roles_code_unique").on(table.code)],
);

export const permissions = pgTable(
  "permissions",
  {
    ...baseColumns,
    /** e.g. "recommendations:approve", "automation:pause" — resource:action. */
    code: varchar("code", { length: 128 }).notNull(),
    description: varchar("description", { length: 500 }),
  },
  (table) => [uniqueIndex("permissions_code_unique").on(table.code)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    ...{ createdAt: baseColumns.createdAt },
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);

/** m:n membership: which user may act on which store with which role (P2/P8/P12). */
export const userStoreMemberships = pgTable(
  "user_store_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    ...{ createdAt: baseColumns.createdAt },
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.storeId] }),
    index("user_store_memberships_store_idx").on(table.storeId),
  ],
);

/** Web session records (merchant login, P2). Embedded-app traffic uses Shopify session tokens instead. */
export const sessions = pgTable(
  "sessions",
  {
    ...baseColumns,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "set null" }),
    userAgent: text("user_agent"),
    ip: varchar("ip", { length: 45 }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [index("sessions_user_idx").on(table.userId, table.expiresAt)],
);

/** Rotating refresh tokens (P2: rotation + expiration). Owned by a session for chain revocation. */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    ...baseColumns,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** SHA-256 of the token — raw tokens are never stored. */
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [uniqueIndex("refresh_tokens_hash_unique").on(table.tokenHash)],
);

/** Public/API-key access for enterprise + future public API (P8). */
export const apiKeys = pgTable(
  "api_keys",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 120 }).notNull(),
    /** SHA-256 of the secret — raw keys are shown once and never stored. */
    keyHash: varchar("key_hash", { length: 128 }).notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [uniqueIndex("api_keys_hash_unique").on(table.keyHash)],
);
