import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphqlPaginator } from "./admin-graphql";
import { ShopifyHttpError } from "./http-client";

const CTX = {
  shopDomain: "demo-store.myshopify.com",
  accessToken: "fixture_access_token",
  apiVersion: "2025-10",
} as const;

function graphqlResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GraphqlPaginator", () => {
  it("pages a connection via endCursor until hasNextPage=false", async () => {
    const variablesSeen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      variablesSeen.push(body.variables);
      if (body.variables["after"] === null) {
        return graphqlResponse({
          data: {
            products: {
              nodes: [{ id: "gid://shopify/Product/1" }],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            },
          },
        });
      }
      return graphqlResponse({
        data: {
          products: {
            nodes: [{ id: "gid://shopify/Product/2" }],
            pageInfo: { hasNextPage: false, endCursor: "c2" },
          },
        },
      });
    }));

    const paginator = new GraphqlPaginator(CTX);
    const ids: string[] = [];
    for await (const page of paginator.paginate<{
      nodes: Array<{ id: string }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    }>("query ($first: Int!, $after: String) { products(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }", "products")) {
      for (const node of page.connection.nodes ?? []) ids.push(node.id);
    }
    expect(ids).toEqual(["gid://shopify/Product/1", "gid://shopify/Product/2"]);
    expect(variablesSeen[1]?.["after"]).toBe("c1");
  });

  it("waits for the cost bucket to repay a page before issuing the next", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        call += 1;
        const hasNext = call === 1;
        return graphqlResponse({
          data: {
            items: {
              nodes: [{ id: String(call) }],
              pageInfo: { hasNextPage: hasNext, endCursor: `c${call}` },
            },
          },
          extensions: {
            cost: {
              requestedQueryCost: 50,
              actualQueryCost: 25,
              throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 10, restoreRate: 50 },
            },
          },
        });
      }));
      const paginator = new GraphqlPaginator(CTX);
      const consumed: string[] = [];
      const run = (async () => {
        for await (const page of paginator.paginate<{
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        }>("query ($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }", "items")) {
          consumed.push(...(page.connection.nodes ?? []).map((n) => n.id));
        }
      })();
      await vi.runAllTimersAsync();
      await run;
      expect(consumed).toEqual(["1", "2"]);
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the requested connection is missing (fail fast, no silent no-op)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphqlResponse({ data: {} })));
    const paginator = new GraphqlPaginator(CTX);
    const iterate = async () => {
      for await (const _ of paginator.paginate("query { whatever }", "missing")) {
        // no-op
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(ShopifyHttpError);
  });

  it("surfaces graphql errors from the payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      graphqlResponse({ errors: [{ message: "throttled hard" }] }),
    ));
    const paginator = new GraphqlPaginator(CTX);
    const iterate = async () => {
      for await (const _ of paginator.paginate("query { whatever }", "items")) {
        // no-op
      }
    };
    await expect(iterate()).rejects.toThrow(/throttled hard/);
  });

  it("resumes from the provided cursor", async () => {
    const variablesSeen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      variablesSeen.push(JSON.parse(String(init?.body)).variables as Record<string, unknown>);
      return graphqlResponse({
        data: { items: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    }));
    const paginator = new GraphqlPaginator(CTX);
    for await (const _ of paginator.paginate<{
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    }>("query ($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }", "items", {}, 100, "resume_cursor")) {
      // consume
    }
    expect(variablesSeen[0]?.["after"]).toBe("resume_cursor");
  });
});
