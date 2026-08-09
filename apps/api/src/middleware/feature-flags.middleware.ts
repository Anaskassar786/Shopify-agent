import type { NextFunction, Request, Response } from "express";
import { featureFlagsFor, isFeatureDisabled, type ProfitDb } from "@profit/db";
import { FeatureFlag } from "@profit/types";
import { FeatureDisabledError } from "../lib/errors";

const FEATURE_LABEL: Record<FeatureFlag, string> = {
  aiDisabled: "AI features",
  automationDisabled: "Automation",
};

/**
 * Per-merchant feature guard (launch readiness, ADR 37): 503 FEATURE_DISABLED
 * when an operator has disabled the capability for this store. Must mount
 * AFTER `requireAppAuth` (needs the verified tenant claim). Reads never use
 * this guard — a disabled feature hides no merchant data.
 */
export function requireFeature(db: ProfitDb, flag: FeatureFlag) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.appAuth === undefined) {
        next(new Error("feature guard mounted before requireAppAuth"));
        return;
      }
      const flags = await featureFlagsFor(db, req.appAuth.storeId);
      if (isFeatureDisabled(flags, flag)) {
        next(new FeatureDisabledError(FEATURE_LABEL[flag]));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
