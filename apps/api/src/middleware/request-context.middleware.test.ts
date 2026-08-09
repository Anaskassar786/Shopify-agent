import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { requestContextMiddleware, REQUEST_ID_HEADER } from "./request-context.middleware";

/**
 * Request-id discipline (P5 logging contract): valid client ids are echoed
 * (traceability), malformed ones are replaced (log-injection safe).
 */

function run(header?: string) {
  const middleware = requestContextMiddleware();
  const req = { header: (name: string) => (name === REQUEST_ID_HEADER ? header : undefined) } as unknown as Request;
  const headers = new Map<string, string>();
  const res = { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as Response;
  let ran = false;
  const next: NextFunction = () => {
    ran = true;
  };
  middleware(req, res, next);
  return { ran, id: headers.get(REQUEST_ID_HEADER) };
}

describe("requestContextMiddleware", () => {
  it("issues a UUID when no id arrives", () => {
    const outcome = run(undefined);
    expect(outcome.ran).toBe(true);
    expect(outcome.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a well-formed client id", () => {
    expect(run("trace_42-ABCdef").id).toBe("trace_42-ABCdef");
  });

  it("rejects ids with log-hostile characters and replaces them", () => {
    const outcome = run('bad\nid"with spaces');
    expect(outcome.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects oversized ids", () => {
    expect(run("x".repeat(129)).id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
