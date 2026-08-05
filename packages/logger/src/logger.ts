import { pino } from "pino";
import type {
  DestinationStream,
  Logger as PinoLogger,
  LoggerOptions,
} from "pino";

/**
 * Structured logging (P1/P5/P12). JSON everywhere — Railway ingests stdout —
 * with mandatory redaction for anything credential-shaped (P5: "never log
 * passwords, tokens, secrets, payment info, API keys"). Child loggers carry
 * request context bindings (requestId, storeId, userId) from the ALS context.
 */

const REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-shopify-access-token']",
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "tokenHash",
  "keyHash",
  "secret",
  "apiKey",
  "encKey",
  "card",
  "paymentInfo",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.tokenHash",
  "*.keyHash",
  "*.secret",
  "*.apiKey",
  "*.card",
  "*.paymentInfo",
];

export interface LoggerConfig {
  readonly level: string;
  readonly service: string;
  readonly environment: string;
  /** Optional destination (tests / log shippers). Defaults to stdout. */
  readonly destination?: DestinationStream;
}

export type Logger = PinoLogger;

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: {
      service: config.service,
      env: config.environment,
    },
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };
  return config.destination !== undefined
    ? pino(options, config.destination)
    : pino(options);
}
