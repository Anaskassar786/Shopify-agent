import { Writable } from "node:stream";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { createLogger } from "@profit/logger";
import { RedisPubSub } from "./redis.pubsub";
import type { PubSubMessage } from "./pubsub.port";

/**
 * Redis driver integration — only runs where a real Redis exists (CI service
 * container / local docker compose). Sandbox has no Redis → self-skips, same
 * gating pattern as the BullMQ driver suite. The driver-agnostic contract is
 * covered hermetically by the MemoryPubSub suite.
 */

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: "fatal", service: "pubsub-test", environment: "test", destination: sink });

const REDIS_URL = process.env["REDIS_URL"];
const suite = REDIS_URL === undefined ? describe.skip : describe;

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timed out"));
      }
    }, 20);
  });
}

suite("RedisPubSub (integration, REDIS_URL-gated)", () => {
  it("fan-out across instances: two drivers exchange messages", async () => {
    const a = new RedisPubSub({ url: REDIS_URL ?? "", logger });
    const b = new RedisPubSub({ url: REDIS_URL ?? "", logger });
    const received: PubSubMessage[] = [];
    const handler = (m: PubSubMessage): void => {
      received.push(m);
    };
    try {
      await b.subscribe("rt:ci-tenant", handler);
      await a.publish("rt:ci-tenant", { kind: "notification.created", id: "n-1" });
      await waitFor(() => received.length === 1);
      expect(received[0]?.payload).toEqual({ kind: "notification.created", id: "n-1" });
      expect(received[0]?.channel).toBe("rt:ci-tenant");

      await b.unsubscribe("rt:ci-tenant", handler);
      await a.publish("rt:ci-tenant", { kind: "notification.created", id: "n-2" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(received).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  }, 10_000);

  it("non-JSON messages are dropped and the subscriber stays alive", async () => {
    const driver = new RedisPubSub({ url: REDIS_URL ?? "", logger });
    const raw = new Redis(REDIS_URL ?? "", { lazyConnect: false });
    const received: PubSubMessage[] = [];
    try {
      await driver.subscribe("rt:ci-garbage", (m) => {
        received.push(m);
      });
      await raw.publish("profit:pubsub:rt:ci-garbage", "{not-json");
      await raw.publish("profit:pubsub:rt:ci-garbage", JSON.stringify({ ok: true }));
      await waitFor(() => received.length === 1);
      expect(received[0]?.payload).toEqual({ ok: true });
    } finally {
      raw.disconnect();
      await driver.close();
    }
  }, 10_000);
});
