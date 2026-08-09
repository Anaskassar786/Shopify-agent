import { randomUUID } from "node:crypto";
import type { Logger } from "@profit/logger";
import { NoopErrorMonitor } from "./noop";
import type { ErrorContext, ErrorMonitor, FetchLike } from "./port";

/**
 * Minimal REAL Sentry capture adapter (launch readiness, ADR 38) — zero new
 * runtime dependencies: speaks the Sentry Envelope protocol over the store
 * endpoint directly. This is deliberately the smallest honest surface:
 * exception events with type/value/stacktrace frames + service/request tags.
 *
 * DSN grammar (official): `{scheme}://{publicKey}@{host}[:port][/path]/{projectId}`
 * Ingest: POST `{scheme}://{host}[:port]{path}/api/{projectId}/envelope/`
 * Auth:  X-Sentry-Auth: Sentry sentry_version=7, sentry_key=..., sentry_client=...
 */
export interface ParsedDsn {
  readonly ingestUrl: string;
  readonly publicKey: string;
}

export function parseSentryDsn(dsn: string): ParsedDsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const publicKey = url.username;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const projectId = segments.pop();
  if (publicKey.length === 0 || projectId === undefined || !/^\d+$/.test(projectId)) {
    return null;
  }
  const base = `${url.protocol}//${url.host}${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
  return { ingestUrl: `${base}/api/${projectId}/envelope/`, publicKey };
}

interface SentryFrame {
  readonly filename: string;
  readonly function?: string;
  readonly lineno?: number;
  readonly colno?: number;
}

interface SentryExceptionEvent {
  readonly event_id: string;
  readonly platform: "node";
  readonly level: "error";
  readonly timestamp: number;
  readonly release: string;
  readonly environment: string;
  readonly server_name?: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly exception: {
    readonly values: readonly {
      readonly type: string;
      readonly value: string;
      readonly mechanism: { readonly type: string; readonly handled: boolean };
      readonly stacktrace?: { readonly frames: readonly SentryFrame[] };
    }[];
  };
}

/** V8 `at fn (file:line:col)` / `at file:line:col` → Sentry frames (reversed = caller-first). */
export function parseStackFrames(stack: string | undefined, cap = 30): readonly SentryFrame[] {
  if (stack === undefined) return [];
  const frames: SentryFrame[] = [];
  for (const line of stack.split("\n").slice(1, cap + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    const body = trimmed.slice(3);
    const parenMatch = /^(?<fn>.*?)\s\((?<loc>[^()]+)\)$/.exec(body);
    const fnName = parenMatch?.groups?.["fn"];
    const location = parenMatch?.groups?.["loc"] ?? body;
    const locMatch = /^(?<file>.*?):(?<line>\d+):(?<col>\d+)$/.exec(location);
    if (locMatch?.groups === undefined) {
      frames.push({ filename: location });
      continue;
    }
    frames.push({
      filename: locMatch.groups["file"] ?? location,
      ...(fnName !== undefined && fnName.length > 0 ? { function: fnName } : {}),
      lineno: Number(locMatch.groups["line"]),
      colno: Number(locMatch.groups["col"]),
    });
  }
  return frames.reverse();
}

function describeError(error: unknown): { type: string; value: string; stack?: string } {
  if (error instanceof Error) {
    return {
      type: error.name,
      value: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }
  return { type: typeof error, value: String(error) };
}

export class SentryErrorMonitor implements ErrorMonitor {
  readonly kind = "sentry" as const;
  private readonly parsed: ParsedDsn;
  private readonly release: string;
  private readonly environment: string;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly serverName: string;

  constructor(options: {
    readonly dsn: string;
    readonly release: string;
    readonly environment: string;
    readonly logger: Logger;
    readonly fetchImpl?: FetchLike;
    readonly timeoutMs?: number;
  }) {
    const parsed = parseSentryDsn(options.dsn);
    if (parsed === null) {
      // Misconfiguration must fail LOUDLY at boot — a silently-dead monitor
      // would be the same lie as a missing adapter.
      throw new Error("SENTRY_DSN is set but could not be parsed ({scheme}://{publicKey}@{host}/{projectId})");
    }
    this.parsed = parsed;
    this.release = options.release;
    this.environment = options.environment;
    this.logger = options.logger;
    this.fetchImpl =
      options.fetchImpl ??
      ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.serverName = process.env["HOSTNAME"] ?? "unknown";
  }

  captureException(error: unknown, context: ErrorContext): Promise<void> {
    // Fire-and-forget: callers never await capture on a hot path; internal
    // promise is guarded so a Sentry outage can never reject into the app.
    return this.deliver(error, context).catch((sendError: unknown) => {
      this.logger.warn({ err: sendError }, "monitoring.sentry.deliver_failed");
    });
  }

  private async deliver(error: unknown, context: ErrorContext): Promise<void> {
    const described = describeError(error);
    const frames = parseStackFrames(described.stack);
    const event: SentryExceptionEvent = {
      event_id: randomUUID().replaceAll("-", ""),
      platform: "node",
      level: "error",
      timestamp: Date.now() / 1000,
      release: this.release,
      environment: this.environment,
      server_name: this.serverName,
      tags: { service: context.service },
      extra: {
        ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
        ...(context.storeId !== undefined ? { storeId: context.storeId } : {}),
        ...(context.userId !== undefined ? { userId: context.userId } : {}),
        ...(context.extra ?? {}),
      },
      exception: {
        values: [
          {
            type: described.type,
            value: described.value,
            mechanism: { type: "generic", handled: false },
            ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
          },
        ],
      },
    };
    const envelope = `${JSON.stringify({ event_id: event.event_id })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.parsed.ingestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${this.parsed.publicKey}, sentry_client=profit-tool/${this.release}`,
        },
        body: envelope,
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn({ status: response.status }, "monitoring.sentry.rejected");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Composition factory: absent DSN ⇒ noop (documented degradation), present+malformed ⇒ loud boot failure. */
export function createErrorMonitor(options: {
  readonly dsn: string | null | undefined;
  readonly release: string;
  readonly environment: string;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}): ErrorMonitor {
  if (options.dsn === undefined || options.dsn === null || options.dsn.trim().length === 0) {
    return new NoopErrorMonitor();
  }
  return new SentryErrorMonitor({
    dsn: options.dsn,
    release: options.release,
    environment: options.environment,
    logger: options.logger,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
