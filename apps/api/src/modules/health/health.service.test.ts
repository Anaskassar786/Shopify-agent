import { describe, expect, it } from "vitest";
import { HealthStatus } from "@profit/types";
import { HealthService } from "./health.service";

describe("HealthService.liveness", () => {
  it("reports version and uptime without touching infrastructure", () => {
    const service = new HealthService({ version: "1.2.3" });
    const live = service.liveness();
    expect(live.status).toBe(HealthStatus.Ok);
    expect(live.version).toBe("1.2.3");
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("HealthService.readiness", () => {
  it("reports the database as skipped (not fabricated) when unconfigured", async () => {
    const service = new HealthService({ version: "0.0.1" });
    const report = await service.readiness();
    expect(report.ready).toBe(true);
    expect(report.checks[0]).toMatchObject({ name: "database", status: "skipped" });
  });

  it("reports ok when the probe succeeds and records latency", async () => {
    const service = new HealthService({ version: "0.0.1", dbProbe: async () => Promise.resolve(1) });
    const report = await service.readiness();
    expect(report.ready).toBe(true);
    expect(report.checks[0]?.status).toBe(HealthStatus.Ok);
    expect(report.checks[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports not ready when the probe fails", async () => {
    const service = new HealthService({
      version: "0.0.1",
      dbProbe: async () => Promise.reject(new Error("connection refused")),
    });
    const report = await service.readiness();
    expect(report.ready).toBe(false);
    expect(report.checks[0]?.status).toBe(HealthStatus.Down);
  });

  it("treats a hung probe as down after the timeout", async () => {
    const service = new HealthService({
      version: "0.0.1",
      probeTimeoutMs: 50,
      dbProbe: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
    });
    const report = await service.readiness();
    expect(report.ready).toBe(false);
    expect(report.checks[0]?.status).toBe(HealthStatus.Down);
  }, 10_000);

  /* ── M7: cache/queue + AI-provider readiness checks (P5) ─────────────── */

  it("probes the shared cache driver and reports latency", async () => {
    const service = new HealthService({
      version: "0.0.1",
      dbProbe: async () => Promise.resolve(1),
      cacheProbe: async () => Promise.resolve(1),
    });
    const report = await service.readiness();
    expect(report.ready).toBe(true);
    expect(report.checks.find((c) => c.name === "cache_queue")).toMatchObject({ status: HealthStatus.Ok });
    expect(report.checks.find((c) => c.name === "cache_queue")?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("marks readiness NOT ready when the cache driver fails (queue would starve)", async () => {
    const service = new HealthService({
      version: "0.0.1",
      dbProbe: async () => Promise.resolve(1),
      cacheProbe: async () => Promise.reject(new Error("redis refused")),
    });
    const report = await service.readiness();
    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.name === "cache_queue")?.status).toBe(HealthStatus.Down);
  });

  it("reports cache as skipped (not fabricated) with no probe wired", async () => {
    const service = new HealthService({ version: "0.0.1" });
    const report = await service.readiness();
    expect(report.checks.find((c) => c.name === "cache_queue")).toMatchObject({ status: "skipped" });
  });

  it("reports AI provider as configuration truth: configured ok, unconfigured skipped", async () => {
    const configured = new HealthService({ version: "0.0.1", aiConfigured: true });
    const reportOk = await configured.readiness();
    expect(reportOk.checks.find((c) => c.name === "ai_provider")).toMatchObject({ status: HealthStatus.Ok, reason: "configured" });

    const bare = new HealthService({ version: "0.0.1" });
    const reportBare = await bare.readiness();
    expect(reportBare.checks.find((c) => c.name === "ai_provider")).toMatchObject({ status: "skipped" });
    // A config check never gates readiness alone — degraded features surface elsewhere.
    expect(reportBare.ready).toBe(true);
  });
});
