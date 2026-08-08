import type { NextFunction, Request, Response } from "express";
import { MaintenanceError } from "../lib/errors";
import { DEFAULT_MAINTENANCE_MESSAGE, type OpsFlagsService } from "../modules/ops/ops-flags.service";

/**
 * Maintenance guard (launch readiness, ADR 37): while the platform flag is
 * enabled, merchant data-plane requests 503 with the typed MAINTENANCE_MODE
 * envelope + the operator's message. Mount AFTER the exempt surfaces
 * (health, /legal, /shopify webhooks+oauth, /api/v1/auth, /api/v1/t,
 * /api/v1/admin = the operator bypass) so those stay up by construction.
 *
 * Read cost is one tiny pk lookup per request against a flag row that barely
 * changes; correctness (maintenance engages on the NEXT request) beats a
 * cached flag here.
 */
export function maintenanceModeGuard(opsFlags: OpsFlagsService) {
  return async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const state = await opsFlags.getMaintenance();
      if (state !== null && state.enabled) {
        next(new MaintenanceError(state.message ?? DEFAULT_MAINTENANCE_MESSAGE));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
