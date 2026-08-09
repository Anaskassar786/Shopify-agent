import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { ProfitDb } from "./client";
import * as schema from "./schema/index";

/**
 * Integration-test database: a REAL PostgreSQL engine (PGlite, WASM Postgres
 * 16) running the REAL migration files — no mocked persistence anywhere. The
 * drizzle query surface is driver-agnostic, so repositories/services behave
 * exactly as they will against Railway Postgres. CI additionally applies the
 * same migrations against a containerized Postgres (docs/ci/ci.yml).
 */
export interface TestDatabase {
  readonly db: ProfitDb;
  readonly client: PGlite;
  close: () => Promise<void>;
}

export async function createTestDatabase(migrationsDir: string): Promise<TestDatabase> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sqlText = readFileSync(join(migrationsDir, file), "utf8");
    // drizzle-kit separates statements with breakpoints; strip the markers.
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    for (const statement of statements) {
      await client.exec(statement);
    }
  }
  const db = drizzle(client, { schema }) as unknown as ProfitDb;
  return {
    db,
    client,
    close: async () => {
      await client.close();
    },
  };
}
