import { HealthStatus } from "@profit/types";

/**
 * Health/readiness reporting (P5). `/live` must never depend on infrastructure
 * (it gates restarts). `/ready` runs REAL dependency probes with tight timeouts:
 * a degraded dependency makes the instance unready, pulling it from rotation.
 * Probes are injected so the service stays unit-testable and queue/AI probes
 * attach in later milestones without touching this file.
 */

export interface DependencyCheckResult {
  readonly name: string;
  readonly status: HealthStatus | "skipped";
  readonly latencyMs?: number;
  readonly reason?: string;
}

export interface LivenessReport {
  readonly status: HealthStatus;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly timestamp: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: readonly DependencyCheckResult[];
  readonly timestamp: string;
}

export interface HealthServiceDeps {
  readonly version: string;
  readonly probeTimeoutMs?: number;
  /** Real DB connectivity probe; undefined → reported as skipped (not fabricated). */
  readonly dbProbe?: () => Promise<unknown>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export class HealthService {
  private readonly version: string;
  private readonly startedAt: Date;
  private readonly probeTimeoutMs: number;
  private readonly dbProbe?: () => Promise<unknown>;

  constructor(deps: HealthServiceDeps) {
    this.version = deps.version;
    this.startedAt = new Date();
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (deps.dbProbe !== undefined) this.dbProbe = deps.dbProbe;
  }

  liveness(): LivenessReport {
    return {
      status: HealthStatus.Ok,
      version: this.version,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const checks: DependencyCheckResult[] = [await this.checkDatabase()];
    const ready = checks.every(
      (check) => check.status === HealthStatus.Ok || check.status === "skipped",
    );
    return { ready, checks, timestamp: new Date().toISOString() };
  }

  private async checkDatabase(): Promise<DependencyCheckResult> {
    if (this.dbProbe === undefined) {
      return { name: "database", status: "skipped", reason: "DATABASE_URL not configured" };
    }
    const start = process.hrtime.bigint();
    try {
      await withTimeout(this.dbProbe(), this.probeTimeoutMs);
      return {
        name: "database",
        status: HealthStatus.Ok,
        latencyMs: elapsedMs(start),
      };
    } catch {
      return {
        name: "database",
        status: HealthStatus.Down,
        latencyMs: elapsedMs(start),
      };
    }
  }
}

function elapsedMs(start: bigint): number {
  return Math.round((Number(process.hrtime.bigint() - start) / 1_000_000) * 100) / 100;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe timeout")), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
