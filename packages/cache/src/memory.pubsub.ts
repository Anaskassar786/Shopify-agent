import type { PubSubHandler, PubSubPort } from "./pubsub.port";

/**
 * In-process driver (tests + single-node dev). Own registry (Map of Sets)
 * rather than a raw EventEmitter so the port's idempotent-subscribe contract
 * holds exactly — EventEmitter allows duplicate listener registration, which
 * would double-deliver. Payloads are deep-cloned on publish so subscribers
 * can never mutate the producer's objects — matching Redis serialization
 * semantics exactly.
 */
export class MemoryPubSub implements PubSubPort {
  private readonly handlers = new Map<string, Set<PubSubHandler>>();
  private closed = false;

  publish(channel: string, payload: unknown): Promise<void> {
    if (this.closed) return Promise.resolve();
    const set = this.handlers.get(channel);
    if (set === undefined || set.size === 0) return Promise.resolve();
    const cloned = JSON.parse(JSON.stringify(payload ?? null)) as unknown;
    for (const handler of set) handler({ channel, payload: cloned });
    return Promise.resolve();
  }

  subscribe(channel: string, handler: PubSubHandler): Promise<void> {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler); // Set semantics: duplicate subscribe registers once.
    return Promise.resolve();
  }

  unsubscribe(channel: string, handler: PubSubHandler): Promise<void> {
    const set = this.handlers.get(channel);
    if (set === undefined) return Promise.resolve();
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(channel);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    return Promise.resolve();
  }
}
