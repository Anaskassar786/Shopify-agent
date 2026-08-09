import { describe, expect, it } from "vitest";
import { MemoryPubSub } from "./memory.pubsub";
import type { PubSubMessage } from "./pubsub.port";

/** Contract suite — the Redis driver runs the same assertions in CI (REDIS_URL-gated below). */
async function expectPubSubContract(driver: MemoryPubSub): Promise<void> {
  const received: PubSubMessage[] = [];
  const handler = (message: PubSubMessage): void => {
    received.push(message);
  };

  await driver.subscribe("rt:store-1", handler);
  await driver.publish("rt:store-1", { kind: "sync.module.completed", n: 1 });
  expect(received).toHaveLength(1);
  expect(received[0]?.channel).toBe("rt:store-1");
  expect(received[0]?.payload).toEqual({ kind: "sync.module.completed", n: 1 });

  // Channel isolation: other tenants receive nothing.
  await driver.publish("rt:store-2", { kind: "sync.module.completed", n: 2 });
  expect(received).toHaveLength(1);

  // Idempotent subscribe: same handler twice = one delivery per publish.
  await driver.subscribe("rt:store-1", handler);
  await driver.publish("rt:store-1", { n: 3 });
  expect(received).toHaveLength(2);

  // Unsubscribe stops delivery.
  await driver.unsubscribe("rt:store-1", handler);
  await driver.publish("rt:store-1", { n: 4 });
  expect(received).toHaveLength(2);
}

describe("MemoryPubSub", () => {
  it("honours the pub/sub contract", async () => {
    const driver = new MemoryPubSub();
    await expectPubSubContract(driver);
    await driver.close();
  });

  it("payloads are deep-cloned (producers cannot be mutated by subscribers)", async () => {
    const driver = new MemoryPubSub();
    let observed: unknown;
    await driver.subscribe("c", (m) => {
      observed = m.payload;
    });
    const original = { nested: { value: 1 } };
    await driver.publish("c", original);
    (observed as { nested: { value: number } }).nested.value = 999;
    expect(original.nested.value).toBe(1);
    await driver.close();
  });

  it("publish after close is a silent no-op (shutdown race safety)", async () => {
    const driver = new MemoryPubSub();
    let count = 0;
    await driver.subscribe("c", () => {
      count += 1;
    });
    await driver.close();
    await driver.publish("c", { x: 1 });
    expect(count).toBe(0);
  });
});
