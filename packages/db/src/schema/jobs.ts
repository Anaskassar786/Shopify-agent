import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { JobStatus } from "@profit/types";
import { baseColumns, enumToPgTuple } from "./_common";
import { stores } from "./merchant";

export const jobStatusEnum = pgEnum("job_status", enumToPgTuple(JobStatus));

/**
 * Durable audit mirror of the BullMQ runtime (ARCHITECTURE §4.2). BullMQ/Redis
 * is the execution substrate; these tables give Super Admin (P4/P7) and the
 * audit trail a queryable, persistent view including idempotency keys.
 * storeId is null for platform-level jobs (e.g. global cleanup).
 */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    ...baseColumns,
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "cascade" }),
    queue: varchar("queue", { length: 64 }).notNull(),
    jobType: varchar("job_type", { length: 128 }).notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: jobStatusEnum("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    /** Unique by design — enqueueing the same idempotency key is a safe no-op (P12). */
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    lastError: text("last_error"),
    runAt: timestamp("run_at", { withTimezone: true, mode: "date" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("background_jobs_idempotency_unique").on(table.idempotencyKey),
    index("background_jobs_store_queue_idx").on(table.storeId, table.queue, table.status),
  ],
);

/** Dead-letter destination after retry exhaustion (P5 alerting hooks off this table). */
export const failedJobs = pgTable(
  "failed_jobs",
  {
    ...baseColumns,
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "cascade" }),
    queue: varchar("queue", { length: 64 }).notNull(),
    jobType: varchar("job_type", { length: 128 }).notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    error: text("error").notNull(),
    stack: text("stack"),
    attemptsMade: integer("attempts_made").notNull().default(0),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("failed_jobs_store_idx").on(table.storeId, table.failedAt)],
);

export const jobRetries = pgTable(
  "job_retries",
  {
    ...baseColumns,
    jobId: uuid("job_id")
      .notNull()
      .references(() => backgroundJobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    error: text("error"),
    retriedAt: timestamp("retried_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("job_retries_job_idx").on(table.jobId)],
);
