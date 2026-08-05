import type { Logger } from "@profit/logger";
import type { CachePort } from "./port";

/**
 * Tenant-scoped, versioned cache addressing (P12: cache keys MUST NOT leak
 * across stores; P2: cache invalidation on data change).
 *
 * Key discipline:
 *   version counter   v:{storeId}:{domain}           (atomic INCR on change)
 *   payload           c:{storeId}:{domain}:{v}:{key}
 *
 * Reads compose the current version into the key — an "invalidation" is one
 * atomic INCR regardless of how many keys the domain holds, so readers NEVER
 * need key enumeration (no SCAN in production, ever), and a store physically
 * cannot address another store's namespace because storeId comes from the
 * authenticated context, not from user input.
 *
 * Cross-process correctness: the worker bumps versions in shared Redis when
 * sync/webhooks mutate data; every API instance composes keys with the same
 * live counters. Stale-interval risk is bounded by the caller's TTL choice.
 */

export type CacheDomain = "analytics" | "catalog" | "store";

export class StoreCache {
  constructor(
    private readonly cache: CachePort,
    private readonly storeId: string,
    private readonly logger?: Logger,
  ) {}

  private versionKey(domain: CacheDomain): string {
    return `v:${this.storeId}:${domain}`;
  }

  async get<TValue>(domain: CacheDomain, key: string): Promise<TValue | null> {
    const version = (await this.cache.get<number>(this.versionKey(domain))) ?? 0;
    return this.cache.get<TValue>(`c:${this.storeId}:${domain}:${String(version)}:${key}`);
  }

  async set<TValue>(
    domain: CacheDomain,
    key: string,
    value: TValue,
    ttlSeconds: number,
  ): Promise<void> {
    const version = (await this.cache.get<number>(this.versionKey(domain))) ?? 0;
    await this.cache.set(
      `c:${this.storeId}:${domain}:${String(version)}:${key}`,
      value,
      ttlSeconds,
    );
  }

  /** Read-through helper: compute-on-miss with stamped entry. */
  async remember<TValue>(
    domain: CacheDomain,
    key: string,
    ttlSeconds: number,
    compute: () => Promise<TValue>,
  ): Promise<TValue> {
    const cached = await this.get<TValue>(domain, key);
    if (cached !== null) return cached;
    const value = await compute();
    await this.set(domain, key, value, ttlSeconds);
    return value;
  }
}

/** Writer-side invalidation — call whenever tenant data in a domain changes. */
export class CacheInvalidator {
  constructor(
    private readonly cache: CachePort,
    private readonly logger: Logger,
  ) {}

  async bump(storeId: string, domain: CacheDomain): Promise<number> {
    const next = await this.cache.incr(`v:${storeId}:${domain}`);
    this.logger.debug({ storeId, domain, version: next }, "cache.domain_invalidated");
    return next;
  }

  async bumpAll(storeId: string, domains: readonly CacheDomain[]): Promise<void> {
    await Promise.all(domains.map((domain) => this.bump(storeId, domain)));
  }
}
