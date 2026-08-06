import { Router, type Router as ExpressRouter } from "express";
import { eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { storeSettings, stores, subscriptions, withStoreScope } from "@profit/db";
import { z } from "zod";
import { getRequestContext } from "../../lib/context/request-context";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { successEnvelope } from "../../lib/http/envelope";
import {
  requireActiveStore,
  requireAppAuth,
  requirePermission,
} from "../../middleware/auth.middleware";
import type { JwtService } from "../auth/jwt.service";
import type { AuditService } from "../audit/audit.service";

/**
 * /api/v1/store (P2). Beyond serving the settings screen, this endpoint is the
 * living proof of the tenant stack: RLS-scoped reads via withStoreScope() —
 * the integration tests assert cross-tenant invisibility through this exact path.
 */
/**
 * Merchant-editable settings (P4 onboarding + Settings screens). Strictly
 * whitelisted per-field: JSONB columns accept only the keys declared here —
 * a merchant can never write provisioning data (RLS-scoped tx, no raw rows).
 */
const patchSettingsSchema = z
  .object({
    branding: z
      .object({
        logoUrl: z.string().url().max(500).nullish(),
        primaryColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, "primaryColor must be a #RRGGBB hex color")
          .nullish(),
      })
      .strict()
      .optional(),
    aiPreferences: z
      .object({
        autonomyMode: z.enum(["SUGGEST", "AUTO_WITH_APPROVAL"]).optional(),
        modelTierOverrides: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    /** M4: autopilot guardrails + abandoned-cart policy (P3 automation modes). */
    automationPreferences: z
      .object({
        mode: z.enum(["MANUAL", "SEMI_AUTOMATIC", "FULLY_AUTOMATIC"]).optional(),
        abandonedCart: z
          .object({
            enabled: z.boolean().optional(),
            delayHours: z.number().int().min(1).max(72).optional(),
            minCartValueCents: z.number().int().min(0).max(100_000_000).optional(),
            discountPercent: z.number().int().min(0).max(50).optional(),
          })
          .strict()
          .optional(),
        autopilot: z
          .object({
            maxDiscountPercent: z.number().int().min(5).max(50).optional(),
            maxEstimatedRevenueCents: z.number().int().min(0).max(1_000_000_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one settings group is required");

export function storeRouter(deps: {
  db: ProfitDb;
  jwt: JwtService;
  audit: AuditService;
}): ExpressRouter {
  const router = Router();

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  router.get("/", requirePermission("store:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const result = await withStoreScope(deps.db, storeId, async (tx) => {
        const storeRows = await tx.select().from(stores).where(eq(stores.id, storeId)).limit(1);
        const store = storeRows[0];
        if (store === undefined) throw new NotFoundError("Store", storeId);
        const settings = await tx
          .select()
          .from(storeSettings)
          .where(eq(storeSettings.storeId, storeId))
          .limit(1);
        const sub = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.storeId, storeId))
          .limit(1);
        return {
          store,
          settings: settings[0] ?? null,
          subscription: sub[0] ?? null,
        };
      });
      res.status(200).json(successEnvelope(getRequestContext(), result));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/settings", requirePermission("settings:update"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const parsed = patchSettingsSchema.safeParse(req.body);
      if (!parsed.success) throw ValidationError.fromZod(parsed.error.issues);
      const storeId = req.appAuth.storeId;
      const patch = parsed.data;
      const updated = await withStoreScope(deps.db, storeId, async (tx) => {
        const rows = await tx
          .select()
          .from(storeSettings)
          .where(eq(storeSettings.storeId, storeId))
          .limit(1);
        const current = rows[0];
        if (current === undefined) throw new NotFoundError("StoreSettings", storeId);
        const nextBranding =
          patch.branding !== undefined
            ? { ...(current.branding as Record<string, unknown>), ...patch.branding }
            : (current.branding as Record<string, unknown>);
        const nextAi =
          patch.aiPreferences !== undefined
            ? { ...(current.aiPreferences as Record<string, unknown>), ...patch.aiPreferences }
            : (current.aiPreferences as Record<string, unknown>);
        // Nested merge for autopilot groups — partial updates must not drop siblings.
        const currentAutomation = current.automationPreferences as Record<string, unknown>;
        const currentAbandoned = (currentAutomation["abandonedCart"] ?? {}) as Record<string, unknown>;
        const currentAutopilot = (currentAutomation["autopilot"] ?? {}) as Record<string, unknown>;
        const nextAutomation =
          patch.automationPreferences !== undefined
            ? {
                ...currentAutomation,
                ...patch.automationPreferences,
                abandonedCart: {
                  ...currentAbandoned,
                  ...(patch.automationPreferences.abandonedCart ?? {}),
                },
                autopilot: {
                  ...currentAutopilot,
                  ...(patch.automationPreferences.autopilot ?? {}),
                },
              }
            : currentAutomation;
        const saved = await tx
          .update(storeSettings)
          .set({
            branding: nextBranding,
            aiPreferences: nextAi,
            automationPreferences: nextAutomation,
            updatedAt: new Date(),
          })
          .where(eq(storeSettings.storeId, storeId))
          .returning();
        const row = saved[0];
        if (row === undefined) throw new NotFoundError("StoreSettings", storeId);
        return row;
      });
      await deps.audit.record({
        storeId,
        userId: req.appAuth.userId,
        action: "settings.updated",
        entityType: "store_settings",
        entityId: updated.id,
        result: "SUCCESS",
        metadata: { groups: Object.keys(patch) },
      });
      res.status(200).json(successEnvelope(getRequestContext(), updated));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Onboarding wizard completion (P4 flow). Sets the durable flag once —
   * subsequent calls are idempotent no-ops returning the same row.
   */
  router.post("/onboarding/complete", requirePermission("settings:update"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const updated = await withStoreScope(deps.db, storeId, async (tx) => {
        const saved = await tx
          .update(storeSettings)
          .set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
          .where(eq(storeSettings.storeId, storeId))
          .returning();
        const row = saved[0];
        if (row === undefined) throw new NotFoundError("StoreSettings", storeId);
        return row;
      });
      await deps.audit.record({
        storeId,
        userId: req.appAuth.userId,
        action: "onboarding.completed",
        entityType: "store_settings",
        entityId: updated.id,
        result: "SUCCESS",
      });
      res.status(200).json(successEnvelope(getRequestContext(), updated));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
