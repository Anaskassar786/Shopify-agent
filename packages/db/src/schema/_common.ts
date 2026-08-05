import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Column presets shared by every table.
 *
 * PART 2 mandate: EVERY business table carries `id`, `store_id`, `created_at`,
 * `updated_at`. `store_id` is added per-table (platform tables like `plans` are
 * documented exceptions — they have no tenant). `updated_at` is maintained by
 * the repository layer on write (DB triggers are intentionally avoided so all
 * mutation logic stays reviewable in application code).
 */
export const baseColumns = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
} as const;

export const softDeleteColumns = {
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
} as const;

/** Converts one of the shared const-enums (packages/types) into a pgEnum spec. */
export function enumToPgTuple<TEnum extends Record<string, string>>(
  source: TEnum,
): [TEnum[keyof TEnum], ...TEnum[keyof TEnum][]] {
  const values = Object.values(source) as TEnum[keyof TEnum][];
  const first = values[0];
  if (first === undefined) {
    throw new Error("enumToPgTuple requires at least one value");
  }
  return [first, ...values.slice(1)];
}
