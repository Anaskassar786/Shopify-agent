/**
 * Cooperative client-side throttle for the Shopify Admin API (P5: rate limit
 * handling). Proactively spacing requests is cheaper than reacting to 429s:
 * the standard REST bucket leaks at 2 req/s, so calls are spaced ≥500ms apart
 * by default. The transport layer still retries 429/5xx with Retry-After
 * backoff on top — the two mechanisms compose, never conflict.
 */

export interface Throttle {
  acquire(): Promise<void>;
}

export interface RestThrottleOptions {
  /** Minimum spacing between REST calls. 500ms ≈ Shopify's 2 req/s leak rate. */
  readonly minIntervalMs?: number;
  /** Injectable for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RestThrottle implements Throttle {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private nextAllowedAt = 0;

  constructor(options: RestThrottleOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.now = options.now ?? (() => Date.now());
  }

  async acquire(): Promise<void> {
    const now = this.now();
    if (now < this.nextAllowedAt) {
      await sleep(this.nextAllowedAt - now);
    }
    this.nextAllowedAt = Math.max(this.now(), this.nextAllowedAt) + this.minIntervalMs;
  }
}

/** No-op throttle for tests/benchmarks — still a real implementation of the contract. */
export class NoThrottle implements Throttle {
  acquire(): Promise<void> {
    return Promise.resolve();
  }
}
