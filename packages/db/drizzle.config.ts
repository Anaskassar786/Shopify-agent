import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated from src/schema and are the ONLY way schema changes
 * reach any environment (PART 2: "Drizzle migrations only"). The URL here is a
 * local default; real environments inject DATABASE_URL (Railway variables).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://profit:profit@localhost:5432/profit_tool_ai",
  },
  strict: true,
  verbose: true,
});
