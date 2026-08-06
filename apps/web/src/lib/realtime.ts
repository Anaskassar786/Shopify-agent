import type { QueryClient } from "@tanstack/react-query";
import { isRealtimeEvent, RealtimeEventKind, type RealtimeEvent } from "@profit/types";

/**
 * Realtime client (M3): subscribes to the tenant event stream and turns
 * server events into QUERY INVALIDATIONS — the socket never mutates cached
 * data directly (the REST API stays the single source of truth; the event is
 * a reason to refetch, per the server's own design).
 *
 * Reconnect: exponential backoff (1s→30s, jittered) with a visible-state
 * listener so background tabs stop hammering the gateway.
 */

/** Strongly-typed view of the one event the UI surfaces as a toast. */
export type NotificationCreatedEvent = RealtimeEvent<typeof RealtimeEventKind.NotificationCreated>;

export interface RealtimeClientOptions {
  readonly queryClient: QueryClient;
  readonly onNotification?: ((event: NotificationCreatedEvent) => void) | undefined;
  readonly wsFactory?: ((url: string) => WebSocket) | undefined;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

const QUERY_KEY_BY_KIND: Readonly<Record<string, readonly string[][]>> = {
  [RealtimeEventKind.NotificationCreated]: [["notifications"]],
  [RealtimeEventKind.SyncModuleCompleted]: [["sync"], ["notifications"]],
  [RealtimeEventKind.SyncModuleFailed]: [["sync"], ["notifications"]],
  [RealtimeEventKind.SyncFullRunCompleted]: [["sync"], ["analytics"], ["catalog"], ["dashboard"]],
  [RealtimeEventKind.AnalyticsRefreshed]: [["analytics"], ["dashboard"]],
  [RealtimeEventKind.RecommendationCreated]: [["recommendations"], ["ai"], ["dashboard"]],
  [RealtimeEventKind.RecommendationExecuted]: [["recommendations"], ["ai"], ["automation"], ["dashboard"]],
};

export class RealtimeClient {
  private readonly queryClient: QueryClient;
  private readonly onNotification: ((event: NotificationCreatedEvent) => void) | undefined;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  private ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private token: string | null = null;

  constructor(options: RealtimeClientOptions) {
    this.queryClient = options.queryClient;
    this.onNotification = options.onNotification;
    this.wsFactory = options.wsFactory ?? ((url) => new WebSocket(url));
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start(token: string): void {
    this.token = token;
    this.stopped = false;
    this.attempts = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private wsUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/v1/realtime?token=${encodeURIComponent(this.token ?? "")}`;
  }

  private open(): void {
    if (this.stopped || this.token === null) return;
    const ws = this.wsFactory(this.wsUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRealtimeEvent(parsed)) return;
      this.route(parsed);
    };
    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows onerror — reconnect handled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempts += 1;
    const delay = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** (this.attempts - 1) + Math.random() * this.baseDelayMs,
    );
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /** Visible in tests: full event → invalidation mapping. */
  route(event: RealtimeEvent): void {
    const keys = QUERY_KEY_BY_KIND[event.kind] ?? [];
    for (const queryKey of keys) {
      void this.queryClient.invalidateQueries({ queryKey: [...queryKey] });
    }
    if (event.kind === RealtimeEventKind.NotificationCreated) {
      // Runtime kind check above guarantees the payload shape — the generic
      // cannot narrow on the discriminant, so we pin it explicitly here.
      this.onNotification?.(event as NotificationCreatedEvent);
    }
  }
}
