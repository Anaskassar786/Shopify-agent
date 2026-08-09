import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyPaginator } from "./admin-rest";
import { NoThrottle } from "./rate-limit";
import { ShopifyHttpError } from "./http-client";

const CTX = {
  shopDomain: "demo-store.myshopify.com",
  accessToken: "fixture_access_token",
  apiVersion: "2025-10",
} as const;

function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShopifyPaginator", () => {
  it("pages through Link headers until rel=next disappears", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (!url.includes("page_info")) {
        return jsonResponse({ products: [{ id: 1 }] }, {
          headers: {
            link: `<https://${CTX.shopDomain}/admin/api/2025-10/products.json?limit=250&page_info=cursor_2>; rel="next"`,
          },
        });
      }
      if (url.includes("page_info=cursor_2")) {
        return jsonResponse({ products: [{ id: 2 }] });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    }));

    const paginator = new ShopifyPaginator(CTX, new NoThrottle());
    const pages: Array<{ body: { products: Array<{ id: number }> }; nextPageInfo: string | null }> = [];
    for await (const page of paginator.paginate<{ products: Array<{ id: number }> }>("products", { status: "active" })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
    expect(pages[0]?.body.products[0]?.id).toBe(1);
    expect(pages[0]?.nextPageInfo).toBe("cursor_2");
    expect(pages[1]?.body.products[0]?.id).toBe(2);
    expect(pages[1]?.nextPageInfo).toBeNull();
    // After the first page, only page_info + limit may be sent (Shopify rule).
    expect(calls[1]).toContain("page_info=cursor_2");
    expect(calls[1]).not.toContain("status=active");
  });

  it("resumes from a stored page_info checkpoint", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return jsonResponse({ orders: [] });
    }));
    const paginator = new ShopifyPaginator(CTX, new NoThrottle());
    const iterator = paginator.paginate<{ orders: unknown[] }>("orders", {}, "saved_cursor");
    await iterator.next();
    expect(calls[0]).toContain("page_info=saved_cursor");
  });

  it("sends the Authorization token header on every request", async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({ products: [] });
    }));
    const paginator = new ShopifyPaginator(CTX, new NoThrottle());
    const it = paginator.paginate<{ products: unknown[] }>("products");
    await it.next();
    expect(seen[0]?.["X-Shopify-Access-Token"]).toBe(CTX.accessToken);
  });

  it("waits on the shared throttle before each request", async () => {
    const acquireCalls: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ products: [] })));
    const throttle = {
      acquire: () => {
        acquireCalls.push(Date.now());
        return Promise.resolve();
      },
    };
    const paginator = new ShopifyPaginator(CTX, throttle);
    const it = paginator.paginate<{ products: unknown[] }>("products");
    await it.next();
    expect(acquireCalls).toHaveLength(1);
  });

  it("treats a malformed Link header as end-of-pages (fails safe)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ products: [] }, { headers: { link: "garbage-not-a-link" } }),
    ));
    const paginator = new ShopifyPaginator(CTX, new NoThrottle());
    const page = await paginator.fetchPage<{ products: unknown[] }>("products", {});
    expect(page.nextPageInfo).toBeNull();
  });

  it("propagates transport errors instead of looping", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: "bad" }, { status: 422 })));
    const paginator = new ShopifyPaginator(CTX, new NoThrottle());
    await expect(paginator.fetchPage("products", {})).rejects.toBeInstanceOf(ShopifyHttpError);
  });
});
