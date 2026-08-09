/**
 * Cache port (P2 response caching; P12 scale-out). Values are JSON-serialized
 * at the boundary so both drivers behave identically; keys are namespaced by
 * the caller (see store-cache.ts for the tenant/version discipline).
 */
export interface CachePort {
  get<TValue>(key: string): Promise<TValue | null>;
  set<TValue>(key: string, value: TValue, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic increment, creating the key at 1 when absent. Returns the new value. */
  incr(key: string): Promise<number>;
  /** Set TTL on an existing key. No-op when the key does not exist. */
  expire(key: string, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

/** Suggested TTLs (seconds) — one place, no magic numbers. */
export const CACHE_TTL = {
  analyticsSummarySeconds: 60,
  storeProfileSeconds: 300,
  rateLimitWindowSeconds: 60,
} as const;
