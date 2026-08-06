import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { RealtimeEventKind, type RealtimeEvent } from "@profit/types";
import { RealtimeClient } from "./realtime";

class MockSocket {
  static instances: MockSocket[] = [];
  readonly url: string;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }

  emitClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  close(): void {
    this.readyState = 3;
  }
}

function event(kind: RealtimeEventKind): RealtimeEvent {
  return {
    kind,
    storeId: "store-1",
    occurredAt: "2026-08-05T08:00:00.000Z",
    payload:
      kind === RealtimeEventKind.NotificationCreated
        ? { notificationId: "n-1", category: "SYSTEM", title: "Data sync complete", body: "All done", actionUrl: null, createdAt: "x" }
        : kind === RealtimeEventKind.SyncModuleCompleted || kind === RealtimeEventKind.SyncModuleFailed
          ? { module: "ORDERS", runId: "r-1" }
          : kind === RealtimeEventKind.SyncFullRunCompleted
            ? { runGroupId: "g-1", modulesCompleted: 8 }
            : kind === RealtimeEventKind.RecommendationCreated
              ? { recommendationId: "rec-1", type: "RECOVER_ABANDONED_CART", title: "Recover a cart", priority: "HIGH" }
              : kind === RealtimeEventKind.RecommendationExecuted
                ? { recommendationId: "rec-1", type: "RECOVER_ABANDONED_CART", actionType: "SEND_RECOVERY_EMAIL", succeeded: true }
                : { dateFrom: null, dateTo: null },
  } as RealtimeEvent;
}

function makeClient(overrides: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  MockSocket.instances = [];
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const client = new RealtimeClient({
    queryClient,
    wsFactory: (url) => new MockSocket(url) as unknown as WebSocket,
    baseDelayMs: 5,
    maxDelayMs: 20,
    ...overrides,
  });
  return { client, invalidate };
}

describe("RealtimeClient", () => {
  it("connects to the tenant stream with the access token in the URL", () => {
    const { client } = makeClient();
    client.start("access-token-1");
    expect(MockSocket.instances).toHaveLength(1);
    expect(MockSocket.instances[0]?.url).toContain("/api/v1/realtime?token=access-token-1");
    client.stop();
  });

  it("invalidates the mapped query families for each event kind", () => {
    const { client, invalidate } = makeClient();
    client.route(event(RealtimeEventKind.SyncModuleCompleted));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sync"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notifications"] });

    invalidate.mockClear();
    client.route(event(RealtimeEventKind.SyncFullRunCompleted));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sync"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["analytics"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["catalog"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });

    invalidate.mockClear();
    client.route(event(RealtimeEventKind.AnalyticsRefreshed));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["analytics"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["catalog"] });

    invalidate.mockClear();
    client.route(event(RealtimeEventKind.SyncModuleFailed));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sync"] });

    // M4: the AI loop streams its own two kinds — both refetch the AI surfaces.
    invalidate.mockClear();
    client.route(event(RealtimeEventKind.RecommendationCreated));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["recommendations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ai"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });

    invalidate.mockClear();
    client.route(event(RealtimeEventKind.RecommendationExecuted));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["recommendations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ai"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["automation"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  });

  it("fires onNotification only for notification.created with a typed payload", () => {
    const onNotification = vi.fn();
    const { client } = makeClient({ onNotification });
    client.route(event(RealtimeEventKind.SyncModuleCompleted));
    expect(onNotification).not.toHaveBeenCalled();
    client.route(event(RealtimeEventKind.NotificationCreated));
    expect(onNotification).toHaveBeenCalledTimes(1);
    const received = onNotification.mock.calls[0]?.[0] as RealtimeEvent<typeof RealtimeEventKind.NotificationCreated>;
    expect(received.payload.title).toBe("Data sync complete");
    client.stop();
  });

  it("ignores malformed socket payloads without throwing", () => {
    const { client, invalidate } = makeClient();
    client.start("t");
    const socket = MockSocket.instances[0];
    socket?.emitMessage("{not json");
    socket?.emitMessage({ hello: "world" });
    socket?.emitMessage(null);
    expect(invalidate).not.toHaveBeenCalled();
    client.stop();
  });

  it("routes valid socket messages into invalidations and reconnects after close", async () => {
    const { client, invalidate } = makeClient();
    client.start("t2");
    const first = MockSocket.instances[0];
    first?.emitOpen();
    first?.emitMessage(event(RealtimeEventKind.SyncModuleCompleted));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sync"] });

    first?.emitClose();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(MockSocket.instances.length).toBeGreaterThan(1);
    client.stop();
  });

  it("stop() prevents further reconnects", async () => {
    const { client } = makeClient();
    client.start("t3");
    const first = MockSocket.instances[0];
    client.stop();
    first?.emitClose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(MockSocket.instances).toHaveLength(1);
  });

  it("isConnected reflects the live socket state", () => {
    const { client } = makeClient();
    expect(client.isConnected).toBe(false);
    client.start("t4");
    expect(client.isConnected).toBe(false);
    MockSocket.instances[0]?.emitOpen();
    // WebSocket.OPEN in the stubbed global is 1 (FakeWebSocket), MockSocket sets 1.
    expect(client.isConnected).toBe(true);
    client.stop();
    expect(client.isConnected).toBe(false);
  });
});
