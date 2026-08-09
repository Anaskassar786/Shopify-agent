import type { Logger } from "@profit/logger";
import { MemoryCache } from "./memory.cache";
import { MemoryPubSub } from "./memory.pubsub";
import type { CachePort } from "./port";
import type { PubSubPort } from "./pubsub.port";
import { RedisCache } from "./redis.cache";
import { RedisPubSub } from "./redis.pubsub";
import { StoreCache, CacheInvalidator } from "./store-cache";

/** Deployment-time driver selection — same rule as the queue (P12). */
export function createCache(options: {
  logger: Logger;
  redisUrl?: string | undefined;
}): CachePort {
  if (options.redisUrl !== undefined && options.redisUrl !== "") {
    return new RedisCache({ url: options.redisUrl });
  }
  options.logger.warn("REDIS_URL not configured — using in-process cache driver");
  return new MemoryCache();
}

/** Pub/Sub driver selection — realtime fan-out across API replicas (M3/P12). */
export function createPubSub(options: {
  logger: Logger;
  redisUrl?: string | undefined;
}): PubSubPort {
  if (options.redisUrl !== undefined && options.redisUrl !== "") {
    return new RedisPubSub({ url: options.redisUrl, logger: options.logger });
  }
  options.logger.warn("REDIS_URL not configured — using in-process pub/sub driver");
  return new MemoryPubSub();
}

export function createStoreCache(cache: CachePort, storeId: string, logger?: Logger): StoreCache {
  return new StoreCache(cache, storeId, logger);
}

export function createCacheInvalidator(cache: CachePort, logger: Logger): CacheInvalidator {
  return new CacheInvalidator(cache, logger);
}
