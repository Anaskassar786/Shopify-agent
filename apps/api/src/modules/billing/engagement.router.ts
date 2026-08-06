import { Router, type Router as ExpressRouter } from "express";
import type { ProfitDb } from "@profit/db";
import { EngagementService } from "@profit/billing";
import { EngagementEventKind } from "@profit/types";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { ForbiddenError } from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import {
  requireActiveStore,
  requireAppAuth,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/engagement (M5 growth telemetry): client-visible EVENTS ONLY.
 * Server-side milestones (sync, AI runs, approvals, subscription) are emitted
 * by their owning services — the client can only ever record view-kind
 * observability events, and only from this whitelist (anything else 400s).
 * Milestones dedupe per store; re-fires are 200 {recorded:false}.
 */
const CLIENT_VISIBLE_KINDS = [
  EngagementEventKind.FirstAiInsightViewed,
  EngagementEventKind.UpgradeViewed,
] as const;

const emitSchema = z
  .object({
    kind: z.enum(CLIENT_VISIBLE_KINDS),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export function engagementRouter(deps: { db: ProfitDb; jwt: JwtService }): ExpressRouter {
  const router = Router();
  const engagement = new EngagementService(deps.db);

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.post("/events", async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new ForbiddenError("auth context missing");
      const body = emitSchema.parse(req.body);
      const recorded = await engagement.emit({
        storeId: req.appAuth.storeId,
        kind: body.kind,
        userId: req.appAuth.userId,
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      });
      res.status(recorded ? 201 : 200).json(successEnvelope(getRequestContext(), { recorded }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
