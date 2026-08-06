import type { NotificationCategory } from "../domain/enums";

/**
 * Realtime wire contract (M3): the single type shared by the worker (which
 * publishes events after durable state changes), the API realtime gateway
 * (which fans them out per tenant), and the web client (which renders toasts
 * and refreshes queries). Adding a kind is a compile-time ripple across all
 * three consumers — wire drift is impossible by construction.
 *
 * Transport: JSON-serialized `RealtimeEvent` per WebSocket message. The
 * channel is the tenant (`rt:{storeId}` handled server-side); the client only
 * ever receives events for its own store because the gateway subscribes
 * per-tenant after JWT authentication.
 */

export const RealtimeEventKind = {
  SyncModuleCompleted: "sync.module.completed",
  SyncModuleFailed: "sync.module.failed",
  SyncFullRunCompleted: "sync.full-run.completed",
  AnalyticsRefreshed: "analytics.refreshed",
  NotificationCreated: "notification.created",
} as const;
export type RealtimeEventKind = (typeof RealtimeEventKind)[keyof typeof RealtimeEventKind];

/** Payload for the notification.created event — mirrors the persisted row. */
export interface RealtimeNotificationPayload {
  readonly notificationId: string;
  readonly category: NotificationCategory;
  readonly title: string;
  readonly body: string;
  readonly actionUrl: string | null;
  readonly createdAt: string;
}

export interface RealtimeEventPayloads {
  readonly [RealtimeEventKind.SyncModuleCompleted]: {
    readonly module: string;
    readonly runId: string;
    readonly stats: Readonly<Record<string, number>>;
  };
  readonly [RealtimeEventKind.SyncModuleFailed]: {
    readonly module: string;
    readonly runId: string;
    readonly errorMessage: string | null;
  };
  readonly [RealtimeEventKind.SyncFullRunCompleted]: {
    readonly runGroupId: string;
    readonly modulesCompleted: number;
  };
  readonly [RealtimeEventKind.AnalyticsRefreshed]: {
    readonly dateFrom: string | null;
    readonly dateTo: string | null;
  };
  readonly [RealtimeEventKind.NotificationCreated]: RealtimeNotificationPayload;
}

export interface RealtimeEvent<TKind extends RealtimeEventKind = RealtimeEventKind> {
  readonly kind: TKind;
  /** Tenant the event belongs to — set by the producer, enforced by the gateway. */
  readonly storeId: string;
  readonly occurredAt: string;
  readonly payload: RealtimeEventPayloads[TKind];
}

const KINDS: readonly string[] = Object.values(RealtimeEventKind);

/** Client-safe structural guard for untrusted socket data. */
export function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["kind"] === "string" &&
    KINDS.includes(record["kind"]) &&
    typeof record["storeId"] === "string" &&
    typeof record["occurredAt"] === "string" &&
    typeof record["payload"] === "object" &&
    record["payload"] !== null
  );
}
