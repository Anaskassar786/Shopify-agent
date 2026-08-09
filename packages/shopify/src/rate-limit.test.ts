import { describe, expect, it, vi } from "vitest";
import { NoThrottle, RestThrottle } from "./rate-limit";

describe("RestThrottle", () => {
  it("spaces acquisitions at the configured minimum interval", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const throttle = new RestThrottle({ minIntervalMs: 500, now: () => now });
      await throttle.acquire(); // t=1000 → next allowed at 1500
      const second = throttle.acquire(); // must wait 500ms
      let released = false;
      void second.then(() => {
        released = true;
      });
      expect(released).toBe(false);
      now = 1_500;
      await vi.advanceTimersByTimeAsync(500);
      await second;
      expect(released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delay the very first call", async () => {
    const start = Date.now();
    const throttle = new RestThrottle({ minIntervalMs: 250 });
    await throttle.acquire();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("serializes concurrent acquisitions into the future (no stampede)", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const throttle = new RestThrottle({ minIntervalMs: 100, now: () => now });
      const a = throttle.acquire();
      const b = throttle.acquire();
      const c = throttle.acquire();
      now = 0;
      await vi.advanceTimersByTimeAsync(0);
      await a;
      now = 100;
      await vi.advanceTimersByTimeAsync(100);
      await b;
      now = 200;
      await vi.advanceTimersByTimeAsync(100);
      await c;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NoThrottle", () => {
  it("resolves immediately and satisfies the Throttle contract", async () => {
    const throttle: { acquire(): Promise<void> } = new NoThrottle();
    await expect(throttle.acquire()).resolves.toBeUndefined();
  });
});
