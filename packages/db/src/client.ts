import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export interface DbClientConfig {
  url: string;
  /** Pool size (P2/P5: connection pooling). Keep small per replica; scale by replica count. */
  maxConnections?: number;
}

export interface DbClient {
  readonly db: ProfitDb;
  readonly sql: postgres.Sql;
  /** Graceful pool shutdown for server/worker lifecycle management. */
  close: () => Promise<void>;
}

export type ProfitDb = ReturnType<typeof createProfitDb>;

function createProfitDb(sqlClient: postgres.Sql) {
  return drizzle(sqlClient, { schema });
}

export function createDbClient(config: DbClientConfig): DbClient {
  const sql = postgres(config.url, {
    max: config.maxConnections ?? 10,
    prepare: true,
    // Fail fast at boot rather than hanging requests behind a dead pool.
    connect_timeout: 10,
    idle_timeout: 20,
  });
  const db = createProfitDb(sql);
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Real connectivity probe used by health/readiness endpoints (P5). */
export async function probeDbConnection(sql: postgres.Sql): Promise<void> {
  await sql`SELECT 1`;
}

export { schema };
