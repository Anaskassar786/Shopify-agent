import { randomUUID } from "node:crypto";
import { Router, type Router as ExpressRouter } from "express";
import { and, desc, eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { syncHistory } from "@profit/db";
import { SyncMode, SyncModule, SyncStatus } from "@profit/types";
import type { JobPersistence, JobQueue } from "@profit/queue";
import {
  FULL_SYNC_ORDER,
  SyncModuleJob,
  SyncStoreFullJob,
} from "@profit/sync";
import { requireActiveStore, requireAppAuth, requirePermission } from "../../middleware/auth.middleware";
import { rateLimitMiddleware, type RateLimitRule } from "../../middleware/rate-limit.middleware";
import { ForbiddenError, ValidationError } from "../../lib/errors";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import { parsePageParams } from "../../lib/http/pagination";
import type { JwtService } from "../auth/jwt.service";
import type { CachePort } from "@profit/cache";

/**
 * /api/v1/sync (P2 sync API). Manual triggers are durable jobs — the POST
 * answers with 202 + job identity instantly, execution lands in the worker
 * (or the in-process driver in single-process deploys), and progress is
 * observable through /status + /history via sync_history.
 */

const MODULE_PERMISSION: Readonly<Record<SyncModule, string>> = {
  [SyncModule.Products]: "products:sync",
  [SyncModule.Customers]: "customers:sync",
  [SyncModule.Orders]: "orders:sync",
  [SyncModule.Inventory]: "inventory:sync",
  [SyncModule.Collections]: "collections:sync",
  [SyncModule.Discounts]: "discounts:sync",
  [SyncModule.Metafields]: "metafields:sync",
};

const SYNC_TRIGGER_RULE: RateLimitRule = { scope: "sync-trigger", max: 30 };

export interface SyncRouterDeps {
  readonly db: ProfitDb;
  readonly jwt: JwtService;
  readonly queue: JobQueue;
  readonly persistence: JobPersistence;
  readonly cache: CachePort;
}

function parseModuleParam(raw: string): SyncModule {
  const normalized = raw.toUpperCase();
  if ((Object.values(SyncModule) as string[]).includes(normalized)) {
    return normalized as SyncModule;
  }
  throw new ValidationError(`unknown sync module: ${raw}`, [
    { code: "VALIDATION_FAILED", message: `module must be one of: ${Object.values(SyncModule).join(", ")}`, field: "module" },
  ]);
}

export function syncRouter(deps: SyncRouterDeps): ExpressRouter {
  const router = Router();

  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  // Full catalog sync (all 7 modules, orchestrated fan-out).
  router.post(
    "/full",
    rateLimitMiddleware(deps.cache, SYNC_TRIGGER_RULE),
    async (req, res, next) => {
      try {
        if (req.appAuth === undefined) throw new Error("auth context missing after guard");
        // Full fan-out requires every module's sync permission (OWNER/ADMIN).
        const missing = FULL_SYNC_ORDER.map((module) => MODULE_PERMISSION[module]).filter(
          (permission) => !req.appAuth!.permissions.includes(permission),
        );
        if (missing.length > 0) {
          throw new ForbiddenError("full sync requires all module sync permissions", {
            missing,
          });
        }
        const storeId = req.appAuth.storeId;
        const runGroupId = randomUUID();
        const jobId = `sync:full:${storeId}:${runGroupId}`;
        await deps.persistence.enqueuePersistent(
          deps.queue,
          SyncStoreFullJob,
          { storeId, runGroupId },
          { jobId },
        );
        res.status(202).json(
          successEnvelope(
            getRequestContext(),
            { jobId, runGroupId, modules: FULL_SYNC_ORDER, status: "QUEUED" },
            { message: "Full sync scheduled" },
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  // Single-module manual sync.
  router.post(
    "/:module",
    rateLimitMiddleware(deps.cache, SYNC_TRIGGER_RULE),
    async (req, res, next) => {
      try {
        if (req.appAuth === undefined) throw new Error("auth context missing after guard");
        const module = parseModuleParam(String(req.params["module"]));
        const required = MODULE_PERMISSION[module];
        if (!req.appAuth.permissions.includes(required)) {
          throw new ForbiddenError(`missing permission: ${required}`, { permission: required });
        }
        const storeId = req.appAuth.storeId;
        const runId = randomUUID();
        const jobId = `sync:manual:${storeId}:${module}:${runId}`;
        await deps.persistence.enqueuePersistent(
          deps.queue,
          SyncModuleJob,
          { storeId, module, mode: SyncMode.Manual },
          { jobId },
        );
        res.status(202).json(
          successEnvelope(
            getRequestContext(),
            { jobId, module, status: "QUEUED" },
            { message: `${module} sync scheduled` },
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  // Latest run per command module — dashboard freshness tiles.
  router.get("/status", requirePermission("store:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const rows = await deps.db
        .select()
        .from(syncHistory)
        .where(eq(syncHistory.storeId, storeId))
        .orderBy(desc(syncHistory.createdAt))
        .limit(200);
      const latestByModule = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (!latestByModule.has(row.module)) latestByModule.set(row.module, row);
      }
      const modules = FULL_SYNC_ORDER.map((module) => {
        const run = latestByModule.get(module);
        return {
          module,
          status: run?.status ?? SyncStatus.Pending,
          mode: run?.mode ?? null,
          stats: (run?.stats as Record<string, unknown> | null) ?? null,
          finishedAt: run?.finishedAt ?? null,
          retryCount: run?.retryCount ?? 0,
          errorMessage: run?.errorMessage ?? null,
        };
      });
      res.status(200).json(
        successEnvelope(getRequestContext(), { storeId, modules }),
      );
    } catch (error) {
      next(error);
    }
  });

  // Paginated run history.
  router.get("/history", requirePermission("store:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const { page, pageSize } = parsePageParams(req.query);
      const storeId = req.appAuth.storeId;
      const rows = await deps.db
        .select()
        .from(syncHistory)
        .where(eq(syncHistory.storeId, storeId))
        .orderBy(desc(syncHistory.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const countRows = await deps.db
        .select({ id: syncHistory.id })
        .from(syncHistory)
        .where(and(eq(syncHistory.storeId, storeId)));
      const totalItems = countRows.length;
      res.status(200).json(
        successEnvelope(getRequestContext(), rows, {
          meta: {
            pagination: {
              page,
              pageSize,
              totalItems,
              totalPages: Math.ceil(totalItems / pageSize),
            },
          },
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
