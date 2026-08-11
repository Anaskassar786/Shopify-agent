import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShopifyHttpError,
  ShopifyNetworkError,
  shopifyGraphql,
  shopifyPostJson,
  shopifyPutJson,
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

describe("shopifyPutJson", () => {
  it("issues a JSON PUT and returns the parsed body (M6 workflow writes)", async () => {
    const captured: { url?: string | undefined; init?: RequestInit | undefined } = {};
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return json({ customer: { id: 7 } });
    }) as unknown as typeof fetch);
    await expect(
      shopifyPutJson("https://shop.example/admin/api/2025-10/customers/7.json", { customer: { id: 7 } }, { "X-Shopify-Access-Token": "t" }),
    ).resolves.toEqual({ customer: { id: 7 } });
    expect(captured.url).toBe("https://shop.example/admin/api/2025-10/customers/7.json");
    expect(captured.init?.method).toBe("PUT");
    expect(captured.init?.headers).toMatchObject({ "X-Shopify-Access-Token": "t", "Content-Type": "application/json" });
  });

  it("fails immediately on 4xx like POST (no retry storms)", async () => {
    const fetchMock = vi.fn(async () => json({ errors: "bad" }, 404));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await expect(shopifyPutJson("https://x", {}, {})).rejects.toMatchObject({ name: "ShopifyHttpError", status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe("401 recovery via onUnauthorized (OFFLINE credential single refresh + retry)", () => {
  it("A. normal 200 request → unchanged, hook never called", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onUnauthorized = vi.fn(async () => "fresh-token");
    await expect(
      shopifyPostJson("https://x", {}, {}, { onUnauthorized }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("B. 401 → refresh hook → retry with new token → 200 success", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1 ? json({ error: "invalid" }, 401) : json({ recovered: true });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const onUnauthorized = vi.fn(async () => "refreshed-token-xyz");

    const result = await shopifyPostJson("https://shop.myshopify.com/admin/...", { a: 1 }, { "X-Shopify-Access-Token": "old" }, { onUnauthorized });

    expect(result).toEqual({ recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // second call must carry the fresh token (safe extraction)
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, { headers?: Record<string, string> }];
    const secondCallHeaders = secondCall?.[1]?.headers || {};
    expect(secondCallHeaders["X-Shopify-Access-Token"]).toBe("refreshed-token-xyz");
  });

  it("C. 401 → refresh → retry → still 401 → fail with exactly two requests, no third", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return json({ still: "bad" }, 401);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const onUnauthorized = vi.fn(async () => "fresh-but-still-fails");

    await expect(
      shopifyPostJson("https://x", {}, { "X-Shopify-Access-Token": "old" }, { onUnauthorized }),
    ).rejects.toMatchObject({ name: "ShopifyHttpError", status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("D. 401 + refresh hook fails/returns null → surface original 401, no retry", async () => {
    const fetchMock = vi.fn(async () => json({ bad: true }, 401));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const onUnauthorized = vi.fn(async () => null);

    await expect(
      shopifyPostJson("https://x", {}, {}, { onUnauthorized }),
    ).rejects.toMatchObject({ name: "ShopifyHttpError", status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("E. 500 behavior remains unchanged (retries per existing policy, no onUnauthorized)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls < 2 ? json({}, 500) : json({ ok: "after-5xx" });
    }) as unknown as typeof fetch);
    vi.useFakeTimers();

    const onUnauthorized = vi.fn(async () => "should-not-be-called");
    const attempt = shopifyPostJson("https://x", {}, {}, { baseDelayMs: 1, maxRetries: 2, onUnauthorized });

    const settled = (async () => {
      for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(50);
      return attempt;
    })();

    await expect(settled).resolves.toEqual({ ok: "after-5xx" });
    expect(calls).toBe(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("F. other 4xx (422) behavior remains unchanged — immediate fail, no refresh", async () => {
    const fetchMock = vi.fn(async () => json({ validation: "fail" }, 422));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onUnauthorized = vi.fn(async () => "never");
    await expect(
      shopifyPostJson("https://x", {}, {}, { onUnauthorized }),
    ).rejects.toMatchObject({ name: "ShopifyHttpError", status: 422 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("G. tokens are never logged (no secret leakage in error messages)", async () => {
    const fetchMock = vi.fn(async () => json({ error: "token expired" }, 401));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onUnauthorized = vi.fn(async () => "super-secret-token-123");

    try {
      await shopifyPostJson("https://x", {}, { "X-Shopify-Access-Token": "old-secret" }, { onUnauthorized });
    } catch (e: any) {
      const msg = String(e?.message || "");
      expect(msg).not.toMatch(/secret|token-123|old-secret/i);
    }
    // also verify the hook itself received no logging side effect (simple check)
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("H. no infinite retry loop on repeated 401s", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return json({ bad: true }, 401);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const onUnauthorized = vi.fn(async () => "fresh");

    await expect(
      shopifyPostJson("https://x", {}, {}, { onUnauthorized, maxRetries: 5 }),
    ).rejects.toMatchObject({ status: 401 });

    // at most 1 initial + 1 retry = 2 calls
    expect(calls).toBeLessThanOrEqual(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
