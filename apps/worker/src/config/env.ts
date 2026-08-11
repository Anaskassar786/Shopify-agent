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
  /** Release stamp reported to the error monitor (same APP_VERSION as the API). */
  APP_VERSION: z.string().min(1).default("1.1.1"),
  /** ADR 38: absent SENTRY_DSN = NoopErrorMonitor (structured logs stay the truth). */
  SENTRY_DSN: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.string().min(1).optional(),
  ENCRYPTION_KEY_PREVIOUS: z.string().min(1).optional(),
  SHOPIFY_API_KEY: z.string().min(1).optional(),
  SHOPIFY_API_SECRET: z.string().min(1).optional(),
  SHOPIFY_APP_URL: z.string().url().optional(),
  SHOPIFY_API_VERSION: z.string().min(1).default("2025-10"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  SYNC_INCREMENTAL_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  SHOPIFY_HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(6),
  SHOPIFY_HTTP_BASE_DELAY_MS: z.coerce.number().int().min(1).max(10_000).default(250),
  ANALYTICS_REFRESH_INTERVAL_MS: z.coerce.number().int().min(300_000).default(21_600_000),
  /** M4 AI plane — absent GEMINI_API_KEY = provider unavailable (failsafe, not an error). */
  GEMINI_API_KEY: z.string().min(1).optional(),
  AI_DEFAULT_GEMINI_MODEL: z.string().min(1).default("gemini-2.0-flash"),
  AI_RUN_INTERVAL_MS: z.coerce.number().int().min(3_600_000).default(21_600_000),
  AI_MEASURE_INTERVAL_MS: z.coerce.number().int().min(3_600_000).default(86_400_000),
  /** M5 billing/growth plane — hourly trial/usage sweeps, daily reconcile/churn. */
  TRIAL_LIFECYCLE_INTERVAL_MS: z.coerce.number().int().min(1_800_000).default(3_600_000),
  USAGE_ROLLUP_INTERVAL_MS: z.coerce.number().int().min(1_800_000).default(3_600_000),
  BILLING_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(3_600_000).default(86_400_000),
  CHURN_SCAN_INTERVAL_MS: z.coerce.number().int().min(3_600_000).default(86_400_000),
  AI_MAX_AGENT_CALLS_PER_RUN: z.coerce.number().int().min(1).max(10).default(5),
  /** M4 email tool — absent SMTP set = email tool unavailable (failsafe). */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().default("noreply@profittool.ai"),
  /** M6 automation center — one TICK scans the whole plane, fans out leaf jobs. */
  AUTOMATION_TICK_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  /** M8 enterprise reporting — due-cadence convergence tick (6h default). */
  REPORTS_TICK_INTERVAL_MS: z.coerce.number().int().min(300_000).default(21_600_000),
  CAMPAIGN_SEND_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  CAMPAIGN_SEND_THROTTLE_MS: z.coerce.number().int().min(0).max(120_000).default(2_000),
  /** M6 SMS channel — absent trio = sms sender unavailable (failsafe, like SMTP). */
  SMS_TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  SMS_TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  SMS_TWILIO_FROM_NUMBER: z.string().min(1).optional(),
  /** M6 tracking links — HMAC signing secret + public base for pixel/redirect URLs. */
  TRACKING_SIGNING_SECRET: z.string().min(1).optional(),
  TRACKING_PUBLIC_BASE_URL: z.string().url().optional(),
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
