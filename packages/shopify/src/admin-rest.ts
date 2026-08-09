import {
  shopifyGetJson,
  ShopifyHttpError,
  type ShopifyHttpOptions,
} from "./http-client";
import { RestThrottle, type Throttle } from "./rate-limit";

/**
 * Shopify Admin REST pagination (P2 sync engine transport).
 *
 * Shopify paginates REST resources with opaque `page_info` cursors carried in
 * RFC-5988 `Link` headers. Rules encoded here:
 *  - first page: caller's query params (limit, updated_at_min, ids, …);
 *  - subsequent pages: ONLY page_info (+limit) is legal — Shopify rejects any
 *    other filter combined with page_info;
 *  - every request passes through the shared throttle so a sync run cooperates
 *    with the 2 req/s standard bucket instead of bouncing off 429s.
 */

export interface ShopifyAdminContext {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly apiVersion: string;
}

export interface RestPage<TBody> {
  readonly body: TBody;
  /** Opaque cursor for the next page, or null when this is the last page. */
  readonly nextPageInfo: string | null;
}

const DEFAULT_PAGE_LIMIT = 250;

function parseNextPageInfo(linkHeader: string | null): string | null {
  if (linkHeader === null || linkHeader === "") return null;
  for (const segment of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(segment.trim());
    if (match === null || match[1] === undefined || match[2] !== "next") continue;
    try {
      const pageInfo = new URL(match[1]).searchParams.get("page_info");
      if (pageInfo !== null && pageInfo !== "") return pageInfo;
    } catch {
      // Malformed Link target — treat biom as no next page rather than loop.
    }
  }
  return null;
}

export class ShopifyPaginator {
  constructor(
    private readonly ctx: ShopifyAdminContext,
    private readonly throttle: Throttle = new RestThrottle({}),
  ) {}

  private resourceUrl(path: string, params: URLSearchParams): string {
    const base = `https://${this.ctx.shopDomain}/admin/api/${this.ctx.apiVersion}/${path}.json`;
    const query = params.toString();
    return query === "" ? base : `${base}?${query}`;
  }

  /** One page of a REST collection resource. */
  async fetchPage<TBody>(
    path: string,
    params: Record<string, string> = {},
    pageInfo: string | null = null,
    options: ShopifyHttpOptions = {},
  ): Promise<RestPage<TBody>> {
    await this.throttle.acquire();
    const search = new URLSearchParams();
    if (pageInfo !== null) {
      search.set("page_info", pageInfo);
      search.set("limit", params["limit"] ?? String(DEFAULT_PAGE_LIMIT));
    } else {
      search.set("limit", params["limit"] ?? String(DEFAULT_PAGE_LIMIT));
      for (const [key, value] of Object.entries(params)) {
        if (key === "limit") continue;
        search.set(key, value);
      }
    }
    const result = await shopifyGetJson<TBody>(
      this.resourceUrl(path, search),
      { "X-Shopify-Access-Token": this.ctx.accessToken },
      { maxRetries: 6, ...options },
    );
    if (typeof result.data !== "object" || result.data === null) {
      throw new ShopifyHttpError(200, "body", `shopify resource ${path} returned malformed JSON`);
    }
    return {
      body: result.data,
      nextPageInfo: parseNextPageInfo(result.headers.get("link")),
    };
  }

  /**
   * Async generator over all pages of a REST collection. `resumeAfter` resumes
   * a previously interrupted run from its stored page_info checkpoint.
   */
  async *paginate<TBody>(
    path: string,
    params: Record<string, string> = {},
    resumeAfter: string | null = null,
    options: ShopifyHttpOptions = {},
  ): AsyncGenerator<RestPage<TBody>, void, void> {
    let pageInfo = resumeAfter;
    for (;;) {
      const page = await this.fetchPage<TBody>(path, params, pageInfo, options);
      yield page;
      if (page.nextPageInfo === null) return;
      pageInfo = page.nextPageInfo;
    }
  }
}
