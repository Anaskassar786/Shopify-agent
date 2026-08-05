import "dotenv/config";
import { z } from "zod";
import { Environment } from "@profit/types";

/**
 * Boot-time configuration (P5: "everything configurable, never hardcode").
 * Loaded once, validated with Zod, and injected into services — modules MUST
 * NOT read process.env directly. In staging/production any missing critical
 * variable fails the boot loudly rather than degrading silently at runtime.
 */

const optionalSecret = z.string().min(1).optional();

const envSchema = z
  .object({
    NODE_ENV: z.nativeEnum(Environment).default(Environment.Development),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_URL: z.string().url().default("http://localhost:3000"),
    APP_VERSION: z.string().min(1).default("0.1.0"),

    DATABASE_URL: optionalSecret,
    REDIS_URL: optionalSecret,

    SHOPIFY_API_KEY: optionalSecret,
    SHOPIFY_API_SECRET: optionalSecret,
    SHOPIFY_APP_URL: z.string().url().optional(),
    SHOPIFY_SCOPES: z.string().min(1).optional(),
    SHOPIFY_API_VERSION: z.string().min(1).default("2025-10"),

    GEMINI_API_KEY: optionalSecret,
    AI_DEFAULT_GEMINI_MODEL: z.string().min(1).default("gemini-2.0-flash"),

    JWT_SECRET: optionalSecret,
    JWT_REFRESH_SECRET: optionalSecret,
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .max(90 * 24 * 3600)
      .default(30 * 24 * 3600),
    ENCRYPTION_KEY: optionalSecret,
    ENCRYPTION_KEY_PREVIOUS: optionalSecret,

    SHOPIFY_BILLING_PLAN: z.string().min(1).optional(),

    SMTP_HOST: optionalSecret,
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: optionalSecret,
    SMTP_PASSWORD: optionalSecret,
    EMAIL_FROM: z.string().email().default("noreply@profittool.ai"),

    WEBHOOK_SECRET: optionalSecret,

    SENTRY_DSN: optionalSecret,
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  })
  .superRefine((env, ctx) => {
    const isHosted =
      env.NODE_ENV === Environment.Production ||
      env.NODE_ENV === Environment.Staging;
    if (!isHosted) return;

    const required: ReadonlyArray<keyof typeof env> = [
      "DATABASE_URL",
      "REDIS_URL",
      "JWT_SECRET",
      "JWT_REFRESH_SECRET",
      "ENCRYPTION_KEY",
      "SHOPIFY_API_KEY",
      "SHOPIFY_API_SECRET",
      "SHOPIFY_APP_URL",
      "SHOPIFY_SCOPES",
    ];
    for (const key of required) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when NODE_ENV=${env.NODE_ENV}`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Environment validation failed:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

export function formatEnvIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/** Parse+validate. Throws EnvValidationError; call once at process start. */
export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new EnvValidationError(formatEnvIssues(result.error));
  }
  return result.data;
}

/** Narrowed accessor so modules can demand a value that is optional in general. */
export function requireEnv<K extends keyof Env>(env: Env, key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined) {
    throw new EnvValidationError([`${String(key)}: required by this module but not configured`]);
  }
  return value as NonNullable<Env[K]>;
}
