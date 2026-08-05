import { createDbClient } from "../client";
import { seedPlatformCatalogs } from "../seed";

/**
 * CLI: apply idempotent platform seeds. Usage: `pnpm --filter @profit/db run seed`
 * Requires DATABASE_URL. Must run AFTER migrations (drizzle-kit migrate).
 */
const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
  console.error("DATABASE_URL is required to seed platform catalogs");
  process.exit(1);
}

const client = createDbClient({ url, maxConnections: 2 });
try {
  const result = await seedPlatformCatalogs(client.db);
  console.log(JSON.stringify({ level: "info", msg: "db.seed.complete", ...result }));
} finally {
  await client.close();
}
