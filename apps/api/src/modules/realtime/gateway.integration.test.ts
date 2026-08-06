import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import WebSocket from "ws";
import { MemoryPubSub } from "@profit/cache";
import { createLogger } from "@profit/logger";
import { NotificationCategory, RealtimeEventKind, UserRole } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtService } from "../auth/jwt.service";
import { createRealtimeGateway, REALTIME_WS_PATH, type RealtimeGateway } from "./gateway";

/**
 * Realtime gateway (M3): JWT-authed, tenant-isolated WebSocket fan-out over
 * the pub/sub port. Proved here: upgrade auth (401 on bad/absent token),
 * per-store subscription management, event delivery shapes, tenant isolation,
 * and clean teardown semantics.
 */

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: "fatal", service: "rt-test", environment: "test", destination: sink });
const SECRET = "rt-test-secret-with-enough-entropy-for-hs256";

const STORE_A = "11111111-1111-4111-8111-111111111111";
const STORE_B = "22222222-2222-4222-8222-222222222222";

let server: Server;
let gateway: RealtimeGateway;
let pubsub: MemoryPubSub;
let jwt: JwtService;
let port = 0;

beforeAll(async () => {
  jwt = new JwtService({ accessSecret: SECRET, accessTtlSeconds: 900 });
  pubsub = new MemoryPubSub();
  gateway = createRealtimeGateway({ jwt, pubsub, logger });
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pubsub.close();
});

async function tokenFor(storeId: string, userId: string): Promise<string> {
  return jwt.signAccessToken({
    userId,
    sessionId: "33333333-3333-4333-8333-333333333333",
    storeId,
    role: UserRole.Owner,
    permissions: ["notifications:read"],
  });
}

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${REALTIME_WS_PATH}?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("upgrade authentication", () => {
  it("rejects missing and invalid tokens with HTTP 401", async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${REALTIME_WS_PATH}`);
        ws.once("open", resolve);
        ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${String(res.statusCode)}`)));
        ws.once("error", reject);
      }),
    ).rejects.toThrow("status 401");

    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${REALTIME_WS_PATH}?token=forged`);
        ws.once("open", resolve);
        ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${String(res.statusCode)}`)));
        ws.once("error", reject);
      }),
    ).rejects.toThrow("status 401");
    expect(gateway.connectionCount()).toBe(0);
  });

  it("accepts a valid token and registers the client under the JWT's store", async () => {
    const token = await tokenFor(STORE_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const ws = await connect(token);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.connectionCount(STORE_A)).toBe(1);
    expect(gateway.connectionCount(STORE_B)).toBe(0);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.connectionCount()).toBe(0);
  });
});

describe("event fan-out", () => {
  it("delivers store-scoped events to that store's sockets only", async () => {
    const tokenA = await tokenFor(STORE_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const tokenB = await tokenFor(STORE_B, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const wsA = await connect(tokenA);
    const wsB = await connect(tokenB);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    wsA.on("message", (raw) => receivedA.push(JSON.parse(String(raw))));
    wsB.on("message", (raw) => receivedB.push(JSON.parse(String(raw))));

    await pubsub.publish("rt:" + STORE_A, {
      kind: RealtimeEventKind.NotificationCreated,
      storeId: STORE_A,
      occurredAt: new Date().toISOString(),
      payload: {
        notificationId: "n-1",
        category: NotificationCategory.System,
        title: "Sync complete",
        body: "done",
        actionUrl: "/dashboard",
        createdAt: new Date().toISOString(),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(receivedA).toHaveLength(1);
    expect((receivedA[0] as { payload: { notificationId: string } }).payload.notificationId).toBe("n-1");
    expect(receivedB).toHaveLength(0); // tenant isolation

    wsA.close();
    wsB.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("drops malformed events without closing the socket", async () => {
    const tokenA = await tokenFor(STORE_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const wsA = await connect(tokenA);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const received: unknown[] = [];
    wsA.on("message", (raw) => received.push(JSON.parse(String(raw))));

    await pubsub.publish("rt:" + STORE_A, { garbage: true });
    await pubsub.publish("rt:" + STORE_A, {
      kind: RealtimeEventKind.SyncModuleCompleted,
      storeId: STORE_A,
      occurredAt: new Date().toISOString(),
      payload: { module: "ORDERS", runId: "run-1", stats: { processed: 10 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(received).toHaveLength(1);
    expect((received[0] as { kind: string }).kind).toBe("sync.module.completed");
    wsA.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("closes cleanly while clients are connected (shutdown race)", async () => {
    const tokenA = await tokenFor(STORE_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const wsA = await connect(tokenA);
    wsA.on("error", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await gateway.close();
    // Re-create for afterAll's close() symmetry and later assertions.
    gateway = createRealtimeGateway({ jwt, pubsub, logger });
    gateway.attach(server);
  });
});
