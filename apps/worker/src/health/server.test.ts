import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@profit/logger";
import { startHealthServer } from "./server";

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: "fatal", service: "health-test", environment: "test", destination: sink });

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers = [];
});

async function boot(probes: { database: () => Promise<void>; queueStarted: () => boolean }) {
  const server = startHealthServer({ logger, port: 0, probes });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

describe("worker health server", () => {
  it("/live reports the process as up without touching dependencies", async () => {
    const base = await boot({
      database: () => Promise.reject(new Error("db down")),
      queueStarted: () => false,
    });
    const response = await fetch(`${base}/live`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("/ready is 200 when probes pass", async () => {
    const base = await boot({ database: () => Promise.resolve(), queueStarted: () => true });
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it("/ready is 503 when the database probe fails", async () => {
    const base = await boot({
      database: () => Promise.reject(new Error("db down")),
      queueStarted: () => true,
    });
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(503);
  });

  it("/ready is 503 while the queue consumer has not started", async () => {
    const base = await boot({ database: () => Promise.resolve(), queueStarted: () => false });
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(503);
  });

  it("unknown paths and methods get a stable 404 shape", async () => {
    const base = await boot({ database: () => Promise.resolve(), queueStarted: () => true });
    const response = await fetch(`${base}/nope`, { method: "POST" });
    expect(response.status).toBe(404);
    const get404 = await fetch(`${base}/nope`);
    expect(get404.status).toBe(404);
  });
});
