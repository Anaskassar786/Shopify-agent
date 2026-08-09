import { and, count, desc, eq, isNull, or } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { notifications, withStoreScope } from "@profit/db";
import type { PubSubPort } from "@profit/cache";
import { NotificationCategory, RealtimeEventKind, type RealtimeEvent } from "@profit/types";
import { z } from "zod";

/**
 * Notification Center service (P4/M3). ONE writer path shared by the API
 * (reads/marks), the worker (sync-failure/completion alerts), and every future
 * producer (AI agents, billing, automation) — notification semantics live here
 * and nowhere else.
 *
 * Ordering contract: persist the row FIRST, then publish the realtime hint;
 * a socket consumer that refreshes from the API therefore always finds the
 * row it was hinted about. `userId` null targets the whole store.
 */

const categoryValues = Object.values(NotificationCategory) as [NotificationCategory, ...NotificationCategory[]];

export const createNotificationInput = z.object({
  category: z.enum(categoryValues),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4_000),
  actionUrl: z.string().max(500).nullable().optional(),
  /** Undefined/null = store-wide. */
  userId: z.string().uuid().nullable().optional(),
});
export type CreateNotificationInput = z.infer<typeof createNotificationInput>;

export interface NotificationRow {
  readonly id: string;
  readonly storeId: string;
  readonly userId: string | null;
  readonly category: NotificationCategory;
  readonly title: string;
  readonly body: string;
  readonly actionUrl: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface ListNotificationsOptions {
  readonly userId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly unreadOnly: boolean;
  readonly category?: NotificationCategory | undefined;
}

export class NotificationService {
  constructor(
    private readonly db: ProfitDb,
    private readonly pubsub: PubSubPort,
  ) {}

  /**
   * Visible set for a user: store-wide rows + rows targeted at them (RLS
   * guarantees tenant isolation; this is the in-tenant audience filter).
   */
  private audience(userId: string) {
    return or(isNull(notifications.userId), eq(notifications.userId, userId));
  }

  async create(storeId: string, input: CreateNotificationInput): Promise<NotificationRow> {
    const parsed = createNotificationInput.parse(input);
    const row = await withStoreScope(this.db, storeId, async (tx) => {
      const inserted = await tx
        .insert(notifications)
        .values({
          storeId,
          userId: parsed.userId ?? null,
          category: parsed.category,
          title: parsed.title,
          body: parsed.body,
          actionUrl: parsed.actionUrl ?? null,
        })
        .returning();
      const first = inserted[0];
      if (first === undefined) throw new Error("notification insert returned no row");
      return first;
    });
    const mapped = toRow(row);
    const event: RealtimeEvent = {
      kind: RealtimeEventKind.NotificationCreated,
      storeId,
      occurredAt: mapped.createdAt.toISOString(),
      payload: {
        notificationId: mapped.id,
        category: mapped.category,
        title: mapped.title,
        body: mapped.body,
        actionUrl: mapped.actionUrl,
        createdAt: mapped.createdAt.toISOString(),
      },
    };
    await this.pubsub.publish(channelFor(storeId), event);
    return mapped;
  }

  async list(
    storeId: string,
    options: ListNotificationsOptions,
  ): Promise<{ rows: readonly NotificationRow[]; total: number; unread: number }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const conditions = [
        eq(notifications.storeId, storeId),
        this.audience(options.userId),
        ...(options.unreadOnly ? [isNull(notifications.readAt)] : []),
        ...(options.category !== undefined ? [eq(notifications.category, options.category)] : []),
      ];
      const where = and(...conditions);
      const [rows, totalRows, unreadRows] = await Promise.all([
        tx
          .select()
          .from(notifications)
          .where(where)
          .orderBy(desc(notifications.createdAt))
          .limit(options.pageSize)
          .offset((options.page - 1) * options.pageSize),
        tx.select({ value: count() }).from(notifications).where(where),
        tx
          .select({ value: count() })
          .from(notifications)
          .where(
            and(
              eq(notifications.storeId, storeId),
              this.audience(options.userId),
              isNull(notifications.readAt),
            ),
          ),
      ]);
      return {
        rows: rows.map(toRow),
        total: Number(totalRows[0]?.value ?? 0),
        unread: Number(unreadRows[0]?.value ?? 0),
      };
    });
  }

  async markRead(
    storeId: string,
    notificationId: string,
    userId: string,
  ): Promise<NotificationRow | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(notifications)
        .set({ readAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.storeId, storeId),
            this.audience(userId),
            isNull(notifications.readAt),
          ),
        )
        .returning();
      if (updated[0] !== undefined) return toRow(updated[0]);
      // Idempotent: already-read rows still answer 200 with the current state.
      const existing = await tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.storeId, storeId),
            this.audience(userId),
          ),
        )
        .limit(1);
      return existing[0] === undefined ? null : toRow(existing[0]);
    });
  }

  async markAllRead(storeId: string, userId: string): Promise<number> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(notifications)
        .set({ readAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(notifications.storeId, storeId),
            this.audience(userId),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });
      return updated.length;
    });
  }
}

/** Tenant realtime channel — the gateway subscribes per authenticated store. */
export function channelFor(storeId: string): string {
  return `rt:${storeId}`;
}

function toRow(row: typeof notifications.$inferSelect): NotificationRow {
  return {
    id: row.id,
    storeId: row.storeId,
    userId: row.userId,
    category: row.category,
    title: row.title,
    body: row.body,
    actionUrl: row.actionUrl,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
