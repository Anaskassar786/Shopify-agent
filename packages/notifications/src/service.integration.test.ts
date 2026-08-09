import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notifications as notificationsTable, stores, users } from "@profit/db";
import { createTestDatabase, type TestDatabase } from "@profit/db/testing";
import { MemoryPubSub } from "@profit/cache";
import type { RealtimeEvent } from "@profit/types";
import { NotificationCategory, RealtimeEventKind, StoreStatus, UserStatus } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotificationService, channelFor } from "./service";

/**
 * Service contract against the REAL schema (PGlite + all migrations 0000→0004
 * incl. RLS): persistence, audience filtering, idempotent marks, and the
 * persist-then-publish realtime ordering.
 */

const here = dirname(fileURLToPath(import.meta.url));
let testDb: TestDatabase;
let pubsub: MemoryPubSub;
let service: NotificationService;
let storeId = "";
let userAId = "";
let userBId = "";

const events: RealtimeEvent[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase(resolve(here, "../../db/drizzle"));
  pubsub = new MemoryPubSub();
  service = new NotificationService(testDb.db, pubsub);

  const storeRows = await testDb.db
    .insert(stores)
    .values({
      shopDomain: "notify-store.myshopify.com",
      name: "Notify Store",
      status: StoreStatus.Active,
    })
    .returning();
  storeId = storeRows[0]!.id;

  const userRows = await testDb.db
    .insert(users)
    .values([
      {
        email: "owner@notify.example",
        fullName: "Owner One",
        status: UserStatus.Active,
      },
      {
        email: "staff@notify.example",
        fullName: "Staff Two",
        status: UserStatus.Active,
      },
    ])
    .returning();
  userAId = userRows[0]!.id;
  userBId = userRows[1]!.id;

  await pubsub.subscribe(channelFor(storeId), (message) => {
    events.push(message.payload as RealtimeEvent);
  });
});

afterAll(async () => {
  await pubsub.close();
  await testDb.close();
});

describe("create", () => {
  it("persists the row then publishes the realtime hint", async () => {
    const row = await service.create(storeId, {
      category: NotificationCategory.System,
      title: "Sync completed",
      body: "Products sync processed 42 rows.",
      actionUrl: "/settings/sync",
    });
    expect(row.id).toBeTruthy();
    expect(row.readAt).toBeNull();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe(RealtimeEventKind.NotificationCreated);
    expect(event.storeId).toBe(storeId);
    expect(event.payload).toMatchObject({
      notificationId: row.id,
      title: "Sync completed",
      category: "SYSTEM",
    });
    // The row is queryable before the event is consumed (ordering contract).
    const listed = await service.list(storeId, {
      userId: userAId,
      page: 1,
      pageSize: 10,
      unreadOnly: false,
    });
    expect(listed.rows.map((r) => r.id)).toContain(row.id);
    expect(listed.unread).toBe(1);
  });

  it("rejects malformed input (zod contract)", async () => {
    await expect(
      service.create(storeId, {
        category: "NOPE" as never,
        title: "",
        body: "x",
      }),
    ).rejects.toThrow();
    expect(events).toHaveLength(1); // nothing published
  });
});

describe("audience semantics", () => {
  it("targeted rows are visible only to their user; store-wide rows to everyone", async () => {
    const targeted = await service.create(storeId, {
      category: NotificationCategory.Billing,
      title: "Trial ends soon",
      body: "Your trial ends in 1 day.",
      userId: userAId,
    });
    const storeWide = await service.create(storeId, {
      category: NotificationCategory.Security,
      title: "New login",
      body: "A new session was created.",
    });

    const forA = await service.list(storeId, {
      userId: userAId,
      page: 1,
      pageSize: 50,
      unreadOnly: false,
    });
    const idsA = forA.rows.map((r) => r.id);
    expect(idsA).toContain(targeted.id);
    expect(idsA).toContain(storeWide.id);

    const forB = await service.list(storeId, {
      userId: userBId,
      page: 1,
      pageSize: 50,
      unreadOnly: false,
    });
    const idsB = forB.rows.map((r) => r.id);
    expect(idsB).not.toContain(targeted.id);
    expect(idsB).toContain(storeWide.id);
  });
});

describe("read state", () => {
  it("markRead is idempotent and filters by audience", async () => {
    const row = await service.create(storeId, {
      category: NotificationCategory.Automation,
      title: "Automation paused",
      body: "Low-stock alerts were paused.",
    });
    const first = await service.markRead(storeId, row.id, userAId);
    expect(first?.readAt).not.toBeNull();
    const second = await service.markRead(storeId, row.id, userAId);
    expect(second?.readAt?.getTime()).toBe(first?.readAt?.getTime());

    const missing = await service.markRead(storeId, randomUUID(), userAId);
    expect(missing).toBeNull();
  });

  it("markAllRead flips only the caller's visible unread rows", async () => {
    await service.create(storeId, {
      category: NotificationCategory.Orders,
      title: "Order paid",
      body: "Order #1001 was paid.",
      userId: userBId,
    });
    const flipped = await service.markAllRead(storeId, userBId);
    expect(flipped).toBeGreaterThanOrEqual(1);
    const after = await service.list(storeId, {
      userId: userBId,
      page: 1,
      pageSize: 10,
      unreadOnly: true,
    });
    expect(after.rows).toHaveLength(0);
    expect(after.unread).toBe(0);
  });

  it("category + unreadOnly filters compose with pagination", async () => {
    await service.markAllRead(storeId, userAId);
    for (let i = 0; i < 3; i += 1) {
      await service.create(storeId, {
        category: NotificationCategory.Inventory,
        title: `Low stock ${String(i)}`,
        body: "Variant below threshold.",
      });
    }
    await service.create(storeId, {
      category: NotificationCategory.Ai,
      title: "Insight ready",
      body: "New revenue opportunity detected.",
    });
    const filtered = await service.list(storeId, {
      userId: userAId,
      page: 1,
      pageSize: 2,
      unreadOnly: true,
      category: NotificationCategory.Inventory,
    });
    expect(filtered.rows).toHaveLength(2);
    expect(filtered.total).toBe(3);
  });
});

describe("tenant isolation", () => {
  it("another store sees zero of our rows (RLS + store filter)", async () => {
    const other = await testDb.db
      .insert(stores)
      .values({
        shopDomain: "other-store.myshopify.com",
        name: "Other",
        status: StoreStatus.Active,
      })
      .returning();
    const listed = await service.list(other[0]!.id, {
      userId: userAId,
      page: 1,
      pageSize: 100,
      unreadOnly: false,
    });
    expect(listed.rows).toHaveLength(0);
    // Sanity: our store's rows still exist (owner-path metadata check).
    const own = await testDb.db.select({ id: notificationsTable.id }).from(notificationsTable);
    expect(own.length).toBeGreaterThan(0);
  });
});
