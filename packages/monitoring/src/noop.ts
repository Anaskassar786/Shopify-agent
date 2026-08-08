import type { ErrorContext, ErrorMonitor } from "./port";

/**
 * The absent-DSN adapter (ADR 38): structured pino logs remain the incident
 * channel — exactly the honest degradation RISKS.md documents.
 */
export class NoopErrorMonitor implements ErrorMonitor {
  readonly kind = "noop" as const;

  captureException(_error: unknown, _context: ErrorContext): Promise<void> {
    return Promise.resolve();
  }
}
