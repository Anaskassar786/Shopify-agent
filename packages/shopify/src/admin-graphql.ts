import {
  shopifyGraphqlRaw,
  ShopifyHttpError,
  type ShopifyHttpOptions,
} from "./http-client";
import type { ShopifyAdminContext } from "./admin-rest";

/**
 * Cost-aware GraphQL connection pagination. The GraphQL Admin API is the
 * efficient path for nested reads (e.g. products→metafields in one round
 * trip). Throttling follows Shopify's calculated-cost model: after each page
 * we read `extensions.cost.throttleStatus` and sleep until the bucket holds
 * at least the requested cost again — never guessing, always measured.
 */

export interface GraphqlConnection<TNode> {
  readonly nodes?: readonly TNode[];
  readonly pageInfo?: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

export interface GraphqlThrottleStatus {
  readonly maximumAvailable: number;
  readonly currentlyAvailable: number;
  readonly restoreRate: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GraphqlPaginator {
  constructor(
    private readonly ctx: ShopifyAdminContext,
    private readonly options: ShopifyHttpOptions = {},
  ) {}

  /**
   * Pages a connection named `connectionKey` on the query root. The caller's
   * query MUST accept `$first: Int!, $after: String` and select
   * `pageInfo { hasNextPage endCursor }` on that connection.
   */
  async *paginate<TConnection extends GraphqlConnection<unknown>>(
    query: string,
    connectionKey: string,
    variables: Record<string, unknown> = {},
    pageSize = 100,
    resumeAfter: string | null = null,
  ): AsyncGenerator<{ connection: TConnection; endCursor: string | null }, void, void> {
    let after = resumeAfter;
    for (;;) {
      const result = await shopifyGraphqlRaw<Record<string, TConnection | null>>(
        this.ctx.shopDomain,
        this.ctx.apiVersion,
        this.ctx.accessToken,
        query,
        { ...variables, first: pageSize, after },
        { maxRetries: 6, ...this.options },
      );
      const connection = result.data[connectionKey] ?? null;
      if (connection === null) {
        throw new ShopifyHttpError(200, "{}", `graphql connection "${connectionKey}" missing in response`);
      }
      // Cost-aware pacing: wait for the throttle bucket to fully repay this page.
      const status = result.extensions?.cost?.throttleStatus;
      const requested = result.extensions?.cost?.requestedQueryCost;
      if (status !== undefined && requested !== undefined && status.currentlyAvailable < requested) {
        const deficit = requested - status.currentlyAvailable;
        const waitMs = (deficit / Math.max(status.restoreRate, 1)) * 1000;
        await sleep(Math.min(Math.max(waitMs, 25), 10_000));
      }
      const endCursor = connection.pageInfo?.endCursor ?? null;
      const hasNext = connection.pageInfo?.hasNextPage ?? false;
      yield { connection, endCursor: hasNext ? endCursor : null };
      if (!hasNext) return;
      after = endCursor;
    }
  }
}
