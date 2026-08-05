import { describe, expect, it } from "vitest";
import {
  getRequestContext,
  patchRequestContext,
  runWithRequestContext,
} from "./request-context";

describe("request context (ALS)", () => {
  it("falls back to a system context outside a request scope", () => {
    expect(getRequestContext().requestId).toBe("system");
  });

  it("exposes the scoped context inside runWithRequestContext", () => {
    const seen = runWithRequestContext({ requestId: "req_1" }, () => getRequestContext().requestId);
    expect(seen).toBe("req_1");
  });

  it("isolates concurrent scopes", async () => {
    const first = runWithRequestContext({ requestId: "req_a" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return getRequestContext().requestId;
    });
    const second = runWithRequestContext({ requestId: "req_b" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getRequestContext().requestId;
    });
    await expect(first).resolves.toBe("req_a");
    await expect(second).resolves.toBe("req_b");
  });

  it("patchRequestContext merges tenant bindings inside a scope only", () => {
    runWithRequestContext({ requestId: "req_2" }, () => {
      patchRequestContext({ storeId: "store_9", userId: "user_3" });
      const ctx = getRequestContext();
      expect(ctx.storeId).toBe("store_9");
      expect(ctx.userId).toBe("user_3");
    });
    patchRequestContext({ storeId: "ignored" });
    expect(getRequestContext().storeId).toBeUndefined();
  });
});
