import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context propagated through async boundaries (P5 logging fields:
 * requestId, userId, storeId on every log line) and the anchor for tenant
 * scoping: the tenant middleware (M1) stores `storeId` here ONCE and the
 * repository layer reads it to enforce store isolation (ARCHITECTURE §3).
 */
export interface RequestContext {
  readonly requestId: string;
  /** Tenant — set by tenant middleware after session validation. */
  storeId?: string;
  userId?: string;
  /** True for platform-admin requests (cross-tenant by design, separate auth surface). */
  isPlatformAdmin?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Fallback context for code paths outside a request (boot, tests, workers can set their own). */
const OUTSIDE_REQUEST_CONTEXT: RequestContext = { requestId: "system" };

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext {
  return storage.getStore() ?? OUTSIDE_REQUEST_CONTEXT;
}

/** Merge additional fields into the active context (used by auth/tenant middleware). */
export function patchRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}
