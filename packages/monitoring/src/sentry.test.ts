import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@profit/logger";
import { NoopErrorMonitor, SentryErrorMonitor, createErrorMonitor, parseSentryDsn, parseStackFrames } from "./index";

const logger = createLogger({ level: "silent", service: "monitoring-test", environment: "test" });

describe("parseSentryDsn (ADR 38)", () => {
  it("builds the ingest URL and public key from a well-formed DSN", () => {
    const parsed = parseSentryDsn("https://abc123@o123.ingest.sentry.io/456789");
    expect(parsed).toEqual({
      ingestUrl: "https://o123.ingest.sentry.io/api/456789/envelope/",
      publicKey: "abc123",
    });
  });

  it("supports region/path prefixes and ports", () => {
    const parsed = parseSentryDsn("https://key@example.com:8443/sentry/99");
    expect(parsed?.ingestUrl).toBe("https://example.com:8443/sentry/api/99/envelope/");
  });

  it("rejects malformed DSNs (missing key, missing project id, non-url)", () => {
    expect(parseSentryDsn("not-a-url")).toBeNull();
    expect(parseSentryDsn("https://@host/123")).toBeNull();
    expect(parseSentryDsn("https://key@host/not-a-number")).toBeNull();
    expect(parseSentryDsn("https://key@host/")).toBeNull();
  });
});

describe("parseStackFrames", () => {
  it("parses V8 frames with function names and reverses to caller-first order", () => {
    const stack = [
      "Error: boom",
      "    at fail (/app/src/thing.ts:10:15)",
      "    at process (/app/node_modules/x/index.js:1:2)",
      "    at /app/plain.js:3:7",
    ].join("\n");
    const frames = parseStackFrames(stack);
    expect(frames).toHaveLength(3);
    // Caller-first ordering (Sentry convention).
    expect(frames[2]).toMatchObject({ filename: "/app/src/thing.ts", function: "fail", lineno: 10, colno: 15 });
    expect(frames[1]).toMatchObject({ filename: "/app/node_modules/x/index.js", function: "process" });
    expect(frames[0]).toMatchObject({ filename: "/app/plain.js" });
  });

  it("returns an empty list when no stack is present", () => {
    expect(parseStackFrames(undefined)).toEqual([]);
    expect(parseStackFrames("Error: no frames")).toEqual([]);
  });
});

describe("SentryErrorMonitor", () => {
  it("throws loudly at construction on a malformed DSN (never a silent dead monitor)", () => {
    expect(() => new SentryErrorMonitor({ dsn: "garbage", release: "1.1.1", environment: "production", logger })).toThrow(/could not be parsed/);
  });

  it("POSTs a well-formed envelope with auth header, tags and stack frames", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      return new Response("ok", { status: 200 });
    });
    const monitor = new SentryErrorMonitor({
      dsn: "https://pubkey@o1.ingest.sentry.io/42",
      release: "1.1.1",
      environment: "production",
      logger,
      fetchImpl,
    });

    const error = new Error("worker exploded");
    await monitor.captureException(error, { service: "worker", requestId: "req-9", storeId: "store-1" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(headers["x-sentry-auth"]).toContain("sentry_key=pubkey");
    expect(headers["x-sentry-auth"]).toContain("sentry_client=profit-tool/1.1.1");

    const lines = String(call.init?.body).split("\n");
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0]!) as { event_id: string };
    expect(JSON.parse(lines[1]!)).toEqual({ type: "event" });
    const event = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(header.event_id).toBe(event["event_id"]);
    expect(event["release"]).toBe("1.1.1");
    expect(event["environment"]).toBe("production");
    expect(event["tags"]).toEqual({ service: "worker" });
    expect(event["extra"]).toMatchObject({ requestId: "req-9", storeId: "store-1" });
    const exception = event["exception"] as { values: { type: string; value: string; stacktrace?: { frames: unknown[] } }[] };
    expect(exception.values[0]?.type).toBe("Error");
    expect(exception.values[0]?.value).toBe("worker exploded");
    expect(exception.values[0]?.stacktrace?.frames.length).toBeGreaterThan(0);
  });

  it("serializes non-Error throws honestly", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("ok", { status: 200 });
    });
    const monitor = new SentryErrorMonitor({ dsn: "https://k@h/1", release: "r", environment: "e", logger, fetchImpl });
    await monitor.captureException("string failure", { service: "api" });
    const event = JSON.parse(bodies[0]!.split("\n")[2]!) as { exception: { values: { type: string; value: string }[] } };
    expect(event.exception.values[0]).toMatchObject({ type: "string", value: "string failure" });
  });

  it("swallows network failures into the log — monitoring never rejects into the app", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("sentry unreachable");
    });
    const monitor = new SentryErrorMonitor({ dsn: "https://k@h/1", release: "r", environment: "e", logger, fetchImpl });
    await expect(monitor.captureException(new Error("x"), { service: "api" })).resolves.toBeUndefined();
  });

  it("logs and resolves on non-2xx ingest responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const monitor = new SentryErrorMonitor({ dsn: "https://k@h/1", release: "r", environment: "e", logger, fetchImpl });
    await expect(monitor.captureException(new Error("x"), { service: "api" })).resolves.toBeUndefined();
  });
});

describe("createErrorMonitor factory", () => {
  it("returns the Noop adapter when DSN is absent/blank (documented degradation)", () => {
    expect(createErrorMonitor({ dsn: undefined, release: "r", environment: "e", logger })).toBeInstanceOf(NoopErrorMonitor);
    expect(createErrorMonitor({ dsn: "   ", release: "r", environment: "e", logger }).kind).toBe("noop");
  });

  it("returns the Sentry adapter when a DSN is configured", async () => {
    const monitor = createErrorMonitor({ dsn: "https://k@h/1", release: "r", environment: "e", logger });
    expect(monitor.kind).toBe("sentry");
    await expect(monitor.captureException(new Error("x"), { service: "api" })).resolves.toBeUndefined();
  });
});

describe("NoopErrorMonitor", () => {
  it("accepts captures as a no-op", async () => {
    const monitor = new NoopErrorMonitor();
    await expect(monitor.captureException(new Error("x"), { service: "api" })).resolves.toBeUndefined();
    expect(monitor.kind).toBe("noop");
  });
});
