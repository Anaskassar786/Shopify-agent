import { describe, expect, it, vi } from "vitest";
import type { ProfitDb } from "@profit/db";
import type { Logger } from "@profit/logger";
import { recordWorkerAudit } from "./audit";

/**
 * Worker audit writer contract (fire-and-forget): optional fields ride the
 * insert only when present, metadata defaults to {}, and a dead database is
 * logged + swallowed — audit must NEVER break the handler's retry contract.
 */

function loggerSpy() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: () => logger,
    level: "fatal",
  };
  return logger as unknown as Logger;
}

describe("recordWorkerAudit", () => {
  it("writes only the fields that were supplied (optionals stay absent)", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          captured.push(row);
          return Promise.resolve();
        },
      }),
    } as unknown as ProfitDb;

    await recordWorkerAudit(db, loggerSpy(), {
      storeId: "store-1",
      action: "ai.run.completed",
      entityType: "ai_run",
      entityId: "run-9",
      result: "SUCCESS",
      metadata: { trigger: "SCHEDULED" },
    });
    expect(captured[0]).toMatchObject({
      storeId: "store-1",
      action: "ai.run.completed",
      entityType: "ai_run",
      entityId: "run-9",
      result: "SUCCESS",
      metadata: { trigger: "SCHEDULED" },
    });

    captured.length = 0;
    await recordWorkerAudit(db, loggerSpy(), { action: "worker.boot", result: "SUCCESS" });
    expect(captured[0]).toMatchObject({ action: "worker.boot", result: "SUCCESS", metadata: {} });
    expect(captured[0]).not.toHaveProperty("storeId");
    expect(captured[0]).not.toHaveProperty("entityType");
    expect(captured[0]).not.toHaveProperty("entityId");
  });

  it("swallows database failures after logging (audit never cascades)", async () => {
    const logger = loggerSpy();
    const db = {
      insert: () => ({
        values: () => Promise.reject(new Error("connection reset")),
      }),
    } as unknown as ProfitDb;

    await expect(
      recordWorkerAudit(db, logger, { action: "ai.run.completed", result: "FAILURE" }),
    ).resolves.toBeUndefined();
    expect((logger as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
  });
});
