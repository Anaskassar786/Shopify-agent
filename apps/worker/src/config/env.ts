import "dotenv/config";
import { z } from "zod";
import { Environment } from "@profit/types";

/**
 * Worker runtime config — validated first, like the API (P5: env-based
 * config, fail fast). Hosted environments REQUIRE durable infrastructure:
 * a worker without Postgres would execute writes against nothing, so prod
 * refuses to boot instead of degrading silently.
 */
const schema = z.object({
  NODE_ENV: z
    .enum([Environment.Development, Environment.Test, Environment.Staging, Environment.Production])
    .default(Environment.Development),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.string().min(1).optional(),
  ENCRYPTION_KEY_PREVIOUS: z.string().min(1).optional(),
  SHOPIFY_APP_URL: z.string().url().optional(),
  SHOPIFY_API_VERSION: z.string().min(1).default("2025-10"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  SYNC_INCREMENTAL_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  SHOPIFY_HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(6),
  SHOPIFY_HTTP_BASE_DELAY_MS: z.coerce.number().int().min(1).max(10_000).default(250),
  ANALYTICS_REFRESH_INTERVAL_MS: z.coerce.number().int().min(300_000).default(21_600_000),
});

const hostedSchema = schema.superRefine((env, ctx) => {
  if (env.NODE_ENV === Environment.Production || env.NODE_ENV === Environment.Staging) {
    for (const key of ["DATABASE_URL", "REDIS_URL", "ENCRYPTION_KEY", "SHOPIFY_APP_URL"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required in ${env.NODE_ENV}`,
        });
      }
    }
  }
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadWorkerEnv(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  const source: Record<string, string | undefined> = { ...process.env, ...overrides };
  const parsed = hostedSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid worker environment: ${details}`);
  }
  return parsed.data;
}

export function requireWorkerEnv<K extends keyof WorkerEnv>(
  env: WorkerEnv,
  key: K,
): NonNullable<WorkerEnv[K]> {
  const value = env[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${String(key)} is required but not configured`);
  }
  return value as NonNullable<WorkerEnv[K]>;
}
