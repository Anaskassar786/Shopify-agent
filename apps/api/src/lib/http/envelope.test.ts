import { describe, expect, it } from "vitest";
import {
  errorEnvelope,
  listMeta,
  paginationMeta,
  successEnvelope,
} from "./envelope";

const ctx = { requestId: "req_test_123" };

describe("successEnvelope", () => {
  it("produces the P2 contract shape", () => {
    const env = successEnvelope(ctx, { id: 1 }, { message: "created" });
    expect(env.success).toBe(true);
    expect(env.message).toBe("created");
    expect(env.data).toEqual({ id: 1 });
    expect(env.errors).toBeNull();
    expect(env.requestId).toBe("req_test_123");
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.meta).toBeNull();
  });

  it("defaults message to OK", () => {
    expect(successEnvelope(ctx, null).message).toBe("OK");
  });

  it("attaches meta when provided", () => {
    const env = successEnvelope(ctx, [], { meta: listMeta(1, 25, 100) });
    expect(env.meta?.pagination?.totalPages).toBe(4);
  });
});

describe("errorEnvelope", () => {
  it("produces the error contract", () => {
    const env = errorEnvelope(ctx, [{ code: "X", message: "bad" }], { message: "failed" });
    expect(env.success).toBe(false);
    expect(env.data).toBeNull();
    expect(env.errors).toHaveLength(1);
    expect(env.requestId).toBe("req_test_123");
  });
});

describe("paginationMeta", () => {
  it("computes totals", () => {
    expect(paginationMeta(2, 50, 125)).toEqual({
      page: 2,
      pageSize: 50,
      totalItems: 125,
      totalPages: 3,
    });
  });

  it("degenerates safely when pageSize is 0", () => {
    expect(paginationMeta(1, 0, 10).totalPages).toBe(0);
  });
});
