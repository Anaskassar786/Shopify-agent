import type { Logger } from "@profit/logger";

/**
 * Error-monitoring port (launch readiness, ADR 38). The PRD (Part-5 "ERROR
 * MONITORING: capture unhandled exceptions · promise rejections · worker
 * failures") requires an out-of-band capture channel; the port keeps business
 * code provider-free (invariant I1) and the Noop adapter keeps Sentry
 * genuinely optional. One rule above all: monitoring must NEVER crash or
 * slow the product — adapters are fire-and-forget with bounded timeouts and
 * swallow their own failures into the pino stream.
 */
export interface ErrorContext {
  /** Originating surface, e.g. "api" | "worker". */
  readonly service: string;
  readonly requestId?: string;
  readonly storeId?: string;
  readonly userId?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface ErrorMonitor {
  readonly kind: "sentry" | "noop";
  captureException(error: unknown, context: ErrorContext): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ErrorMonitorOptions {
  readonly dsn: string | null | undefined;
  readonly release: string;
  readonly environment: string;
  readonly logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
  /** Bounded network budget per capture (default 1500ms). */
  readonly timeoutMs?: number;
}
