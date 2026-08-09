import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@profit/logger";
import { MemoryCache } from "./memory.cache";
import { RedisCache } from "./redis.cache";
import { CacheInvalidator, StoreCache } from "./store-cache";
import { createCache } from "./factory";

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: "fatal", service: "cache-test", environment: "test", destination: sink });

describe("MemoryCache", () => {
  it("round-trips JSON values", async () => {
    const cache = new MemoryCache();
    await cache.set("k", { a: [1, 2], b: "x" });
    await expect(cache.get("k")).resolves.toEqual({ a: [1, 2], b: "x" });
    await expect(cache.get("missing")).resolves.toBeNull();
  });

  it("expires entries after their TTL", async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache();
      await cache.set("k", 1, 1);
      vi.advanceTimersByTime(1_100);
      await expect(cache.get("k")).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("incr is atomic and preserve TTLs", async () => {
    const cache = new MemoryCache();
    await expect(cache.incr("n")).resolves.toBe(1);
    await expect(cache.incr("n")).resolves.toBe(2);
    await cache.expire("n", 60);
    await expect(cache.incr("n")).resolves.toBe(3);
    await cache.del("n");
    await expect(cache.incr("n")).resolves.toBe(1);
    await expect(cache.expire("absent", 10)).resolves.toBeUndefined();
    await cache.set("s", "not-a-number");
    await expect(cache.incr("s")).rejects.toThrow(/not numeric/);
  });
});

describe("StoreCache + CacheInvalidator (tenant versioning)", () => {
  it("serves cached values until invalidation bumps the version", async () => {
    const cache = new MemoryCache();
    const storeCache = new StoreCache(cache, "store-1", logger);
    const invalidator = new CacheInvalidator(cache, logger);

    let computations = 0;
    const compute = async () => {
      computations += 1;
      return { total: computations * 100 };
    };

    const first = await storeCache.remember("analytics", "summary", 60, compute);
    const second = await storeCache.remember("analytics", "summary", 60, compute);
    expect(first).toEqual({ total: 100 });
    expect(second).toEqual({ total: 100 });
    expect(computations).toBe(1);

    await invalidator.bump("store-1", "analytics");
    const third = await storeCache.remember("analytics", "summary", 60, compute);
    expect(third).toEqual({ total: 200 });
  });

  it("store namespaces are physically separated", async () => {
    const cache = new MemoryCache();
    const a = new StoreCache(cache, "store-a");
    const b = new StoreCache(cache, "store-b");
    await a.set("catalog", "k", "A", 60);
    await b.set("catalog", "k", "B", 60);
    await expect(a.get("catalog", "k")).resolves.toBe("A");
    await expect(b.get("catalog", "k")).resolves.toBe("B");
    // Invalidating A never touches B:
    await new CacheInvalidator(cache, logger).bumpAll("store-a", ["catalog"]);
    await expect(a.get("catalog", "k")).resolves.toBeNull();
    await expect(b.get("catalog", "k")).resolves.toBe("B");
  });

  it("bumpAll invalidates every listed domain and returns new versions", async () => {
    const cache = new MemoryCache();
    const invalidator = new CacheInvalidator(cache, logger);
    await invalidator.bumpAll("store-9", ["analytics", "store"]);
    await expect(cache.get<number>("v:store-9:analytics")).resolves.toBe(1);
    await expect(cache.get<number>("v:store-9:store")).resolves.toBe(1);
    await expect(invalidator.bump("store-9", "analytics")).resolves.toBe(2);
  });
});

describe("factory", () => {
  it("returns the in-process driver without REDIS_URL", async () => {
    const cache = createCache({ logger });
    expect(cache).toBeInstanceOf(MemoryCache);
    await cache.close();
  });

  it("returns the Redis driver when REDIS_URL is configured", async () => {
    const cache = createCache({ logger, redisUrl: "redis://127.0.0.1:6390" });
    expect(cache).toBeInstanceOf(RedisCache);
    await cache.close();
  });
});
