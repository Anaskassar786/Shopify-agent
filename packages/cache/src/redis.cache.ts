import { Redis } from "ioredis";
import type { CachePort } from "./port";

/**
 * Production driver (P2: Redis caching; P12 multi-instance). A dedicated
 * keyPrefix isolates cache entries from BullMQ's keyspace on a shared Redis.
 */
export class RedisCache implements CachePort {
  private readonly redis: Redis;

  constructor(options: { url: string; keyPrefix?: string; lazyConnect?: boolean }) {
    this.redis = new Redis(options.url, {
      keyPrefix: options.keyPrefix ?? "profit:cache:",
      maxRetriesPerRequest: 3,
      lazyConnect: options.lazyConnect ?? false,
    });
  }

  async get<TValue>(key: string): Promise<TValue | null> {
    const raw = await this.redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as TValue);
  }

  async set<TValue>(key: string, value: TValue, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds !== undefined) {
      await this.redis.set(key, serialized, "EX", ttlSeconds);
      return;
    }
    await this.redis.set(key, serialized);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
