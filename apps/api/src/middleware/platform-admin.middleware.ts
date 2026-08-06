import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AuditService } from "../modules/audit/audit.service";
import { AuthenticationError, MaintenanceError } from "../lib/errors";
import { patchRequestContext } from "../lib/context/request-context";

/**
 * Platform-admin guard (M5 Super Admin v1, P12). Deliberately separate from
 * the tenant JWT stack: operators authenticate with a single env-provisioned
 * key (PLATFORM_ADMIN_KEY) sent as `X-Platform-Admin-Key`. The key is
 * constant-time compared via hashes (never direct string compare), and EVERY
 * accepted request is audit-logged as a platform action (store_id null).
 *
 * When the env key is absent the surface reports itself unavailable (503) —
 * it never opens by default and never mocks access.
 */
export function requirePlatformAdmin(deps: {
  platformAdminKey: string | undefined;
  audit: AuditService;
}) {
  const expected = deps.platformAdminKey !== undefined && deps.platformAdminKey !== ""
    ? createHash("sha256").update(deps.platformAdminKey).digest()
    : null;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (expected === null) {
      next(new MaintenanceError("Platform admin is not configured for this environment"));
      return;
    }
    const provided = req.header("x-platform-admin-key");
    const providedHash = provided !== undefined && provided !== ""
      ? createHash("sha256").update(provided).digest()
      : null;
    if (providedHash === null || !timingSafeEqual(providedHash, expected)) {
      next(new AuthenticationError("Valid platform admin key required"));
      return;
    }
    // Log correlation: admin traffic reads cross-tenant; mark the context so
    // scoped-repository assertions treat it as the documented exception.
    patchRequestContext({ isPlatformAdmin: true });
    // Fire-and-forget audit: every admin read is on the record (P12 audit).
    // storeId stays absent — platform actions are outside any tenant (schema
    // already allows NULL there).
    void deps.audit.record({
      action: `platform.admin.${req.method.toLowerCase()}`,
      entityType: "platform",
      entityId: req.baseUrl + req.path,
      result: "SUCCESS",
      ...(req.ip !== undefined ? { ip: req.ip } : {}),
    });
    next();
  };
}
