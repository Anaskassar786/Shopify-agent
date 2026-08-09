import { Redis } from "ioredis";
import type { Logger } from "@profit/logger";
import type { PubSubHandler, PubSubPort } from "./pubsub.port";

/**
 * Production driver. Redis requires a *dedicated* connection in subscriber
 * mode (a subscribe()d client cannot run other commands), so this driver owns
 * two connections: one publisher, one subscriber. Channel names are namespaced
 * with the same prefix discipline as RedisCache (shared keyspace, no bleed
 * into BullMQ's channels).
 */
export class RedisPubSub implements PubSubPort {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, Set<PubSubHandler>>();
  private readonly prefix: string;
  private closed = false;

  constructor(options: { url: string; logger: Logger; channelPrefix?: string }) {
    this.prefix = options.channelPrefix ?? "profit:pubsub:";
    this.publisher = new Redis(options.url, { lazyConnect: true });
    this.subscriber = new Redis(options.url, { lazyConnect: true });
    this.subscriber.on("message", (rawChannel: string, raw: string) => {
      const channel = rawChannel.slice(this.prefix.length);
      let payload: unknown = null;
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        options.logger.warn({ channel }, "redis pubsub: dropping non-JSON message");
        return;
      }
      const set = this.handlers.get(channel);
      if (set === undefined) return;
      for (const handler of set) handler({ channel, payload });
    });
    this.subscriber.on("error", (error) => {
      options.logger.error({ err: error }, "redis pubsub subscriber error");
    });
    this.publisher.on("error", (error) => {
      options.logger.error({ err: error }, "redis pubsub publisher error");
    });
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    if (this.closed) return;
    await this.publisher.publish(this.prefix + channel, JSON.stringify(payload ?? null));
  }

  async subscribe(channel: string, handler: PubSubHandler): Promise<void> {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.subscriber.subscribe(this.prefix + channel);
    }
    if (set.has(handler)) return;
    set.add(handler);
  }

  async unsubscribe(channel: string, handler: PubSubHandler): Promise<void> {
    const set = this.handlers.get(channel);
    if (set === undefined) return;
    set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(channel);
      await this.subscriber.unsubscribe(this.prefix + channel);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
