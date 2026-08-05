import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShopifyHttpError,
  ShopifyNetworkError,
  shopifyGraphql,
  shopifyPostJson,
} from "./http-client";

/**
 * Network-resilience semantics (P5: retry safely; P6: network errors handled).
 * fetch is stubbed at the global boundary — the client itself is the code
 * under test.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shopifyPostJson", () => {
  it("returns parsed JSON on first success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true })) as typeof fetch);
    await expect(shopifyPostJson("https://x", {}, {})).resolves.toEqual({ ok: true });
  });

  it("fails immediately on 4xx — retrying cannot help (P12: no retry storms)", async () => {
    const fetchMock = vi.fn(async () => json({ errors: "bad" }, 422));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const attempt = shopifyPostJson("https://x", {}, {});
    await expect(attempt).rejects.toMatchObject({ name: "ShopifyHttpError", status: 422 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx with backoff and succeeds within the budget", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls < 3 ? json({}, 502) : json({ recovered: true });
    }) as unknown as typeof fetch);
    vi.useFakeTimers();
    const attempt = shopifyPostJson("https://x", {}, {}, { baseDelayMs: 1, maxRetries: 3 });
    const settled = (async () => {
      for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(50);
      return attempt;
    })();
    await expect(settled).resolves.toEqual({ recovered: true });
    expect(calls).toBe(3);
  });

  it("surfaces ShopifyHttpError after exhausting retries on persistent 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 500)) as unknown as typeof fetch);
    vi.useFakeTimers();
    const attempt = shopifyPostJson("https://x", {}, {}, { baseDelayMs: 1, maxRetries: 2 });
    const expectation = expect(attempt).rejects.toMatchObject({ status: 500 });
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(100);
    await expectation;
  });

  it("times out a hung request deterministically (P5: no indefinite awaits)", async () => {
    vi.stubGlobal("fetch", vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ) as unknown as typeof fetch);
    await expect(
      shopifyPostJson("https://x", {}, {}, { timeoutMs: 20, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(ShopifyNetworkError);
  });
});

describe("shopifyGraphql", () => {
  it("throws on GraphQL-level errors with a 200 envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ errors: [{ message: "broken query" }] })) as unknown as typeof fetch);
    await expect(
      shopifyGraphql("shop.myshopify.com", "2025-10", "token", "query X { a }", {}),
    ).rejects.toBeInstanceOf(ShopifyHttpError);
  });

  it("returns data when valid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { shop: { id: "1" } } })) as unknown as typeof fetch);
    await expect(
      shopifyGraphql("shop.myshopify.com", "2025-10", "token", "query X { a }", {}),
    ).resolves.toEqual({ shop: { id: "1" } });
  });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
