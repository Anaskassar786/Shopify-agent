import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import type { ProfitDb } from "@profit/db";
import { CopilotNotFoundError, CopilotService, type AiProvider } from "@profit/ai";
import { FeatureFlag } from "@profit/types";
import { getRequestContext } from "../../lib/context/request-context";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import { requireFeature } from "../../middleware/feature-flags.middleware";
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/copilot — the M8 merchant Q&A surface (ADR 32/35). Every answer is
 * evidence-backed and persisted server-side; reads/writes stay inside the
 * tenant scope the auth context pins.
 */

const askBodySchema = z
  .object({
    question: z.string().trim().min(2).max(500),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

export interface CopilotRouterDeps {
  readonly db: ProfitDb;
  readonly jwt: JwtService;
  readonly provider: AiProvider | null;
}

function mapCopilotError(error: unknown): unknown {
  if (error instanceof CopilotNotFoundError) return new NotFoundError("Conversation", "unknown");
  return error;
}

export function copilotRouter(deps: CopilotRouterDeps): ExpressRouter {
  const router = Router();
  const service = new CopilotService({ db: deps.db, provider: deps.provider });

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  /** Ask a question — starts a conversation or threads into an existing one. */
  router.post(
    "/ask",
    requireFeature(deps.db, FeatureFlag.AiDisabled),
    requirePermission("copilot:ask"),
    async (req, res, next) => {
      try {
        if (req.appAuth === undefined) throw new Error("auth context missing after guard");
        const body = askBodySchema.safeParse(req.body ?? {});
        if (!body.success) throw ValidationError.fromZod(body.error.issues);
        const result = await service.ask(req.appAuth.storeId, req.appAuth.userId, {
          question: body.data.question,
          ...(body.data.conversationId !== undefined ? { conversationId: body.data.conversationId } : {}),
        });
        res.status(201).json(
          successEnvelope(getRequestContext(), {
            conversationId: result.conversationId,
            messageId: result.messageId,
            intent: result.intent,
            answer: result.answer,
            modelEnhanced: result.modelEnhanced,
            evidence: result.evidence,
          }),
        );
      } catch (error) {
        next(mapCopilotError(error));
      }
    },
  );

  /** Conversation list (most recent first). */
  router.get("/conversations", requirePermission("copilot:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const items = await service.listConversations(req.appAuth.storeId);
      res.status(200).json(successEnvelope(getRequestContext(), items));
    } catch (error) {
      next(mapCopilotError(error));
    }
  });

  /** One conversation with its message trail (evidence payloads included). */
  router.get("/conversations/:id", requirePermission("copilot:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const detail = await service.getConversation(req.appAuth.storeId, req.params["id"]!);
      res.status(200).json(successEnvelope(getRequestContext(), detail));
    } catch (error) {
      next(mapCopilotError(error));
    }
  });

  return router;
}
