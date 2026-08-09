import { index, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { NotificationCategory } from "@profit/types";
import { baseColumns, enumToPgTuple } from "./_common";
import { users } from "./iam";
import { stores } from "./merchant";

export const notificationCategoryEnum = pgEnum(
  "notification_category",
  enumToPgTuple(NotificationCategory),
);

/**
 * Notification Center rows (P4: categories AI / orders / inventory / billing /
 * security / automation / system; realtime via the WS gateway, persisted here
 * first so the drawer reconstructs state after reconnect/refresh without
 * depending on the socket. Producers write rows THEN publish the realtime
 * event — the database is the source of truth, the socket is a hint.
 *
 * `userId` null = store-wide notification (e.g. sync failures); set = targeted
 * at one merchant user.
 */
export const notifications = pgTable(
  "notifications",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    category: notificationCategoryEnum("category").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    /** In-app deep link (e.g. "/settings/sync"); validated server-side when read. */
    actionUrl: varchar("action_url", { length: 500 }),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("notifications_store_created_idx").on(table.storeId, table.createdAt),
    index("notifications_store_unread_idx").on(table.storeId, table.readAt),
    index("notifications_user_idx").on(table.userId),
  ],
);
