import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import type { ProfitDb } from "./client";
import { createTestDatabase, type TestDatabase } from "./testing";
import { currentScopedStoreId, execRaw, withStoreScope } from "./scope";
import { PERMISSION_CODES, seedPlatformCatalogs } from "./seed";
import { permissions, plans, rolePermissions, roles, stores } from "./schema/index";

/**
 * Real-Postgres (PGlite) contract tests for the shared persistence layer:
 * seed idempotency, the tenant-scope transaction helper, and the raw executor.
 * The API suite exercises these through HTTP; here they are pinned directly.
 */

let testDb: TestDatabase;
let db: ProfitDb;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  testDb = await createTestDatabase(resolve(here, "../drizzle"));
  db = testDb.db;
});

afterAll(async () => {
  await testDb.close();
});

describe("seedPlatformCatalogs", () => {
  it("seeds roles, permissions, role-permission matrix and plans", async () => {
    const result = await seedPlatformCatalogs(db);
    expect(result.roles).toBe(7);
    expect(result.permissions).toBe(PERMISSION_CODES.length);
    const roleRows = await db.select().from(roles);
    const permRows = await db.select().from(permissions);
    const rpRows = await db.select().from(rolePermissions);
    const planRows = await db.select().from(plans);
    expect(roleRows.length).toBe(7);
    expect(permRows.length).toBe(PERMISSION_CODES.length);
    expect(rpRows.length).toBeGreaterThan(permRows.length); // OWNER+ADMIN hold all
    expect(planRows.map((p) => p.code).sort()).toEqual(
      ["ENTERPRISE", "GROWTH", "PROFESSIONAL", "STARTER"].sort(),
    );
  });

  it("is idempotent — re-running changes nothing", async () => {
    await seedPlatformCatalogs(db);
    const before = await db.select().from(rolePermissions);
    await seedPlatformCatalogs(db);
    const after = await db.select().from(rolePermissions);
    expect(after.length).toBe(before.length);
  });
});

describe("withStoreScope + raw helpers", () => {
  it("pins app.store_id inside the transaction (visible to currentScopedStoreId)", async () => {
    const inserted = await db
      .insert(stores)
      .values({ shopDomain: "scope-test.myshopify.com", name: "Scope Test" })
      .returning({ id: stores.id });
    const storeId = inserted[0]!.id;

    const pinned = await withStoreScope(db, storeId, async (tx) => {
      return currentScopedStoreId(tx);
    });
    expect(pinned).toBe(storeId);
  });

  it("RLS hides other tenants' rows from the scoped role", async () => {
    const a = await db
      .insert(stores)
      .values({ shopDomain: "tenant-a.myshopify.com", name: "Tenant A" })
      .returning({ id: stores.id });
    const b = await db
      .insert(stores)
      .values({ shopDomain: "tenant-b.myshopify.com", name: "Tenant B" })
      .returning({ id: stores.id });

    const visible = await withStoreScope(db, a[0]!.id, async (tx) => {
      return tx.select({ id: stores.id }).from(stores);
    });
    const ids = visible.map((row) => row.id);
    expect(ids).toContain(a[0]!.id);
    expect(ids).not.toContain(b[0]!.id);
  });

  it("a scoped write that violates the tenant policy is rejected (fail closed)", async () => {
    const a = await db
      .insert(stores)
      .values({ shopDomain: "tenant-c.myshopify.com", name: "Tenant C" })
      .returning({ id: stores.id });
    await expect(
      withStoreScope(db, a[0]!.id, async (tx) =>
        tx.insert(stores).values({ shopDomain: "forged-owner.myshopify.com", name: "Forged" }),
      ),
    ).rejects.toThrow();
  });

  it("execRaw normalizes driver-specific result shapes", async () => {
    const rows = await execRaw<{ one: number }>(db, drizzleSql`SELECT 1 AS one`);
    expect(rows).toEqual([{ one: 1 }]);
  });

  it("currentScopedStoreId returns null outside a pinned transaction", async () => {
    await expect(currentScopedStoreId(db)).resolves.toBeNull();
  });
});
