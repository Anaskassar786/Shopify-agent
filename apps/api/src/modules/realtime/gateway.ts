import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Logger } from "@profit/logger";
import type { PubSubPort } from "@profit/cache";
import { channelFor } from "@profit/notifications";
import { isRealtimeEvent } from "@profit/types";
import type { JwtService } from "../auth/jwt.service";

/**
 * Realtime gateway (M3/P4 Notification Center live updates). Design choices,
 * permanently:
 *  - The socket is a HINT, never the source of truth: consumers refetch from
 *    the REST API after an event; missed events cost one extra read, never
 *    lost state (Redis pub/sub is at-most-once).
 *  - Tenant isolation is structural: the JWT's storeId decides the single
 *    pub/sub channel the socket receives — a client cannot request topics.
 *  - Multi-replica correctness comes from Redis pub/sub (P12); the memory
 *    driver keeps single-process dev/tests hermetic via the same port.
 *  - Heartbeat detects dead sockets behind proxies (30 s ping, liveness flag).
 */

const WS_PATH = "/api/v1/realtime";
const HEARTBEAT_MS = 30_000;

interface ClientState {
  readonly socket: WebSocket;
  readonly storeId: string;
  alive: boolean;
}

export interface RealtimeGateway {
  attach(server: Server): void;
  close(): Promise<void>;
  /** Test/diagnostic surface: live socket count per store. */
  connectionCount(storeId?: string): number;
}

export function createRealtimeGateway(deps: {
  jwt: JwtService;
  pubsub: PubSubPort;
  logger: Logger;
  /** Channel resolver (injectable for unit tests). */
  subscriber?: Pick<PubSubPort, "subscribe" | "unsubscribe">;
}): RealtimeGateway {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientState>();
  const subscribedStores = new Map<string, number>();
  const bus = deps.subscriber ?? deps.pubsub;
  let closed = false;

  const onStoreEvent = (storeId: string) => (message: { payload: unknown }) => {
    const payload = message.payload;
    if (!isRealtimeEvent(payload) || payload.storeId !== storeId) return;
    const frame = JSON.stringify(payload);
    for (const client of clients) {
      if (client.storeId === storeId && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(frame);
      }
    }
  };
  const storeHandlers = new Map<string, ReturnType<typeof onStoreEvent>>();

  async function addStoreSubscription(storeId: string): Promise<void> {
    const count = (subscribedStores.get(storeId) ?? 0) + 1;
    subscribedStores.set(storeId, count);
    if (count === 1) {
      const handler = onStoreEvent(storeId);
      storeHandlers.set(storeId, handler);
      await bus.subscribe(channelFor(storeId), handler);
    }
  }

  async function removeStoreSubscription(storeId: string): Promise<void> {
    const count = (subscribedStores.get(storeId) ?? 0) - 1;
    if (count > 0) {
      subscribedStores.set(storeId, count);
      return;
    }
    subscribedStores.delete(storeId);
    const handler = storeHandlers.get(storeId);
    if (handler !== undefined) {
      storeHandlers.delete(storeId);
      await bus.unsubscribe(channelFor(storeId), handler);
    }
  }

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? "", "http://localhost");
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    if (token === null || token === "") {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    let storeId: string;
    let userId: string;
    try {
      const claims = await deps.jwt.verifyAccessToken(token);
      storeId = claims.storeId;
      userId = claims.userId;
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const state: ClientState = { socket: ws, storeId, alive: true };
      clients.add(state);
      ws.on("pong", () => {
        state.alive = true;
      });
      ws.on("close", () => {
        clients.delete(state);
        removeStoreSubscription(storeId).catch((error: unknown) => {
          deps.logger.error({ err: error, storeId }, "realtime.unsubscribe.failed");
        });
      });
      ws.on("error", (error) => {
        deps.logger.warn({ err: error, storeId, userId }, "realtime.socket.error");
      });
      addStoreSubscription(storeId).catch((error: unknown) => {
        deps.logger.error({ err: error, storeId }, "realtime.subscribe.failed");
      });
    });
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    attach(server: Server): void {
      server.on("upgrade", (request, socket, head) => {
        handleUpgrade(request, socket, head).catch((error: unknown) => {
          deps.logger.error({ err: error }, "realtime.upgrade.failed");
          socket.destroy();
        });
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const client of clients) client.socket.terminate();
      clients.clear();
      const stores = [...storeHandlers.keys()];
      await Promise.all(
        stores.map(async (storeId) => {
          const handler = storeHandlers.get(storeId);
          if (handler !== undefined) await bus.unsubscribe(channelFor(storeId), handler);
        }),
      );
      storeHandlers.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    connectionCount(storeId?: string): number {
      if (storeId === undefined) return clients.size;
      let count = 0;
      for (const client of clients) if (client.storeId === storeId) count += 1;
      return count;
    },
  };
}

export const REALTIME_WS_PATH = WS_PATH;
