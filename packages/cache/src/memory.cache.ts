import type { CachePort } from "./port";

/**
 * In-process cache driver — full port semantics (TTL expiry, atomic incr)
 * without infrastructure. Powers hermetic tests and single-process deploys;
 * cross-process deployments select the Redis driver via createCache().
 */

interface Entry {
  readonly value: string;
  readonly expiresAtMs: number | null;
}

export class MemoryCache implements CachePort {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private live(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  get<TValue>(key: string): Promise<TValue | null> {
    const entry = this.live(key);
    if (entry === null) return Promise.resolve(null);
    return Promise.resolve(JSON.parse(entry.value) as TValue);
  }

  set<TValue>(key: string, value: TValue, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value: JSON.stringify(value),
      expiresAtMs: ttlSeconds !== undefined ? this.now() + ttlSeconds * 1000 : null,
    });
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  incr(key: string): Promise<number> {
    const entry = this.live(key);
    const nextValue = entry === null ? 1 : Number(JSON.parse(entry.value)) + 1;
    if (!Number.isFinite(nextValue)) {
      return Promise.reject(new Error(`cache key "${key}" is not numeric`));
    }
    this.entries.set(key, {
      value: JSON.stringify(nextValue),
      expiresAtMs: entry?.expiresAtMs ?? null,
    });
    return Promise.resolve(nextValue);
  }

  expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.live(key);
    if (entry === null) return Promise.resolve();
    this.entries.set(key, { ...entry, expiresAtMs: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}
