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
});
