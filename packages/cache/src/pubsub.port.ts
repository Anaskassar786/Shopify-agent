/**
 * Pub/Sub port (M3 realtime fan-out, P12 event channel). Producers publish
 * JSON-serializable messages to named channels; consumers subscribe with a
 * handler. The port deliberately hides Redis wiring: the API realtime gateway
 * and the worker swap drivers without code changes (memory driver keeps tests
 * hermetic — same contract as MemoryCache/MemoryJobQueue).
 *
 * Delivery semantics match Redis pub/sub: at-most-once, no replay. Anything
 * that must survive a disconnect is written to Postgres first (notifications
 * table) — the socket is a low-latency hint, never the source of truth.
 */
export interface PubSubMessage {
  readonly channel: string;
  readonly payload: unknown;
}

export type PubSubHandler = (message: PubSubMessage) => void;

export interface PubSubPort {
  /** Serialize + publish. Rejects nothing by contract — payload must be JSON-safe. */
  publish(channel: string, payload: unknown): Promise<void>;
  /** Idempotent per (channel, handler): subscribing twice registers once. */
  subscribe(channel: string, handler: PubSubHandler): Promise<void>;
  unsubscribe(channel: string, handler: PubSubHandler): Promise<void>;
  close(): Promise<void>;
}
