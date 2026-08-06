import { Router, type Router as ExpressRouter } from "express";
import { and, asc, desc, eq, gte, sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  customerMetrics,
  dailyMetrics,
  productMetrics,
  revenueMetrics,
  shopifyCustomers,
  shopifyProducts,
  withStoreScope,
} from "@profit/db";
import type { StoreCache } from "@profit/cache";
import { CACHE_TTL } from "@profit/cache";
import { ROI_WINDOWS_DAYS, RoiReportService, type RoiWindowDays } from "@profit/ai";
import { requireActiveStore, requireAppAuth, requirePermission } from "../../middleware/auth.middleware";
import { getRequestContext } from "../../lib/context/request-context";
import { successEnvelope } from "../../lib/http/envelope";
import { ValidationError } from "../../lib/errors";
import type { JwtService } from "../auth/jwt.service";

/**
 * /api/v1/analytics (P2 analytics endpoints; P4 dashboard backing). Reads hit
 * the PRECOMPUTED metrics tables only (P12: dashboards never scan
 * transactional tables) and pass through StoreCache.remember with a 60s TTL —
 * sync/webhook completion version-bumps the domain, so freshness after data
 * change is immediate while hot reads stay at Redis speed.
 */

const ALLOWED_DAYS = new Set([7, 30, 90]);

function parseDays(raw: unknown): number {
  if (raw === undefined) return 30;
  const days = Number(raw);
  if (!ALLOWED_DAYS.has(days)) {
    throw new ValidationError("invalid range", [
      { code: "VALIDATION_FAILED", message: "days must be one of 7, 30, 90", field: "days" },
    ]);
  }
  return days;
}

function sinceDate(days: number): string {
  const date = new Date(Date.now() - days * 24 * 3600 * 1000);
  return date.toISOString().slice(0, 10);
}

export interface AnalyticsRouterDeps {
  readonly db: ProfitDb;
  readonly jwt: JwtService;
  readonly storeCacheFor: (storeId: string) => StoreCache;
}

export function analyticsRouter(deps: AnalyticsRouterDeps): ExpressRouter {
  const router = Router();
  router.use(requireAppAuth(deps.jwt), requireActiveStore(deps.db));

  /**
   * M5 ROI read-model (P11 ROI reporting): measured attribution vs metered AI
   * cost + live open pipeline. Served uncached — it is the value proof on the
   * Billing page, where stale numbers erode exactly the trust it builds.
   */
  router.get("/roi", requirePermission("analytics:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const raw = typeof req.query["windowDays"] === "string" ? Number(req.query["windowDays"]) : 30;
      if (!ROI_WINDOWS_DAYS.includes(raw as RoiWindowDays)) {
        throw new ValidationError("invalid window", [
          { code: "VALIDATION_FAILED", message: "windowDays must be 30 or 90", field: "windowDays" },
        ]);
      }
      const report = await new RoiReportService(deps.db).report(
        req.appAuth.storeId,
        raw as RoiWindowDays,
      );
      res.status(200).json(successEnvelope(getRequestContext(), report));
    } catch (error) {
      next(error);
    }
  });

  router.get("/summary", requirePermission("analytics:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const days = parseDays(req.query["days"]);
      const since = sinceDate(days);

      const summary = await deps
        .storeCacheFor(storeId)
        .remember("analytics", `summary:${String(days)}`, CACHE_TTL.analyticsSummarySeconds, async () => {
          return withStoreScope(deps.db, storeId, async (tx) => {
            const totalRows = await tx
              .select({
                ordersCount: sql<number>`COALESCE(SUM(${dailyMetrics.ordersCount}), 0)::int`,
                cancelledOrders: sql<number>`COALESCE(SUM(${dailyMetrics.cancelledOrders}), 0)::int`,
                itemsSold: sql<number>`COALESCE(SUM(${dailyMetrics.itemsSold}), 0)::int`,
                newCustomers: sql<number>`COALESCE(SUM(${dailyMetrics.newCustomers}), 0)::int`,
                returningCustomers: sql<number>`COALESCE(SUM(${dailyMetrics.returningCustomers}), 0)::int`,
              })
              .from(dailyMetrics)
              .where(and(eq(dailyMetrics.storeId, storeId), gte(dailyMetrics.metricDate, since)));
            const revenueRows = await tx
              .select({
                grossSalesCents: sql<number>`COALESCE(SUM(${revenueMetrics.grossSalesCents}), 0)::bigint`,
                discountsCents: sql<number>`COALESCE(SUM(${revenueMetrics.discountsCents}), 0)::bigint`,
                refundsCents: sql<number>`COALESCE(SUM(${revenueMetrics.refundsCents}), 0)::bigint`,
                netSalesCents: sql<number>`COALESCE(SUM(${revenueMetrics.netSalesCents}), 0)::bigint`,
                taxesCents: sql<number>`COALESCE(SUM(${revenueMetrics.taxesCents}), 0)::bigint`,
                shippingCents: sql<number>`COALESCE(SUM(${revenueMetrics.shippingCents}), 0)::bigint`,
              })
              .from(revenueMetrics)
              .where(and(eq(revenueMetrics.storeId, storeId), gte(revenueMetrics.metricDate, since)));
            const series = await tx
              .select({
                date: dailyMetrics.metricDate,
                ordersCount: dailyMetrics.ordersCount,
                itemsSold: dailyMetrics.itemsSold,
                newCustomers: dailyMetrics.newCustomers,
              })
              .from(dailyMetrics)
              .where(and(eq(dailyMetrics.storeId, storeId), gte(dailyMetrics.metricDate, since)))
              .orderBy(asc(dailyMetrics.metricDate));
            const revenueSeries = await tx
              .select({
                date: revenueMetrics.metricDate,
                netSalesCents: revenueMetrics.netSalesCents,
                grossSalesCents: revenueMetrics.grossSalesCents,
                refundsCents: revenueMetrics.refundsCents,
                currency: revenueMetrics.currency,
              })
              .from(revenueMetrics)
              .where(and(eq(revenueMetrics.storeId, storeId), gte(revenueMetrics.metricDate, since)))
              .orderBy(asc(revenueMetrics.metricDate));

            const totals = totalRows[0]!;
            const revenue = revenueRows[0]!;
            const aovCents = totals.ordersCount > 0
              ? Math.round(Number(revenue.netSalesCents) / totals.ordersCount)
              : 0;
            return {
              totals: {
                ...totals,
                grossSalesCents: Number(revenue.grossSalesCents),
                discountsCents: Number(revenue.discountsCents),
                refundsCents: Number(revenue.refundsCents),
                netSalesCents: Number(revenue.netSalesCents),
                taxesCents: Number(revenue.taxesCents),
                shippingCents: Number(revenue.shippingCents),
                aovCents,
                currency: revenueSeries[0]?.currency ?? "USD",
              },
              series: series.map((day) => {
                const revenueDay = revenueSeries.find((candidate) => candidate.date === day.date);
                return {
                  ...day,
                  netSalesCents: revenueDay?.netSalesCents ?? 0,
                  grossSalesCents: revenueDay?.grossSalesCents ?? 0,
                  refundsCents: revenueDay?.refundsCents ?? 0,
                };
              }),
            };
          });
        });

      res.status(200).json(
        successEnvelope(getRequestContext(), {
          range: { days, since },
          ...summary,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/top-products", requirePermission("analytics:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const days = parseDays(req.query["days"]);
      const limit = Math.min(Math.max(Number(req.query["limit"] ?? 10) || 10, 1), 50);
      const since = sinceDate(days);

      const rows = await deps
        .storeCacheFor(storeId)
        .remember("analytics", `top-products:${String(days)}:${String(limit)}`, CACHE_TTL.analyticsSummarySeconds, async () => {
          return withStoreScope(deps.db, storeId, async (tx) => {
            return tx
              .select({
                productId: productMetrics.productId,
                title: shopifyProducts.title,
                unitsSold: sql<number>`SUM(${productMetrics.unitsSold})::int`,
                revenueCents: sql<number>`SUM(${productMetrics.revenueCents})::bigint`,
              })
              .from(productMetrics)
              .innerJoin(shopifyProducts, eq(shopifyProducts.id, productMetrics.productId))
              .where(and(eq(productMetrics.storeId, storeId), gte(productMetrics.metricDate, since)))
              .groupBy(productMetrics.productId, shopifyProducts.title)
              .orderBy(desc(sql`SUM(${productMetrics.revenueCents})`))
              .limit(limit);
          });
        });

      res.status(200).json(
        successEnvelope(
          getRequestContext(),
          rows.map((row) => ({ ...row, revenueCents: Number(row.revenueCents) })),
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/top-customers", requirePermission("analytics:read"), async (req, res, next) => {
    try {
      if (req.appAuth === undefined) throw new Error("auth context missing after guard");
      const storeId = req.appAuth.storeId;
      const limit = Math.min(Math.max(Number(req.query["limit"] ?? 10) || 10, 1), 50);

      const rows = await deps
        .storeCacheFor(storeId)
        .remember("analytics", `top-customers:${String(limit)}`, CACHE_TTL.analyticsSummarySeconds, async () => {
          return withStoreScope(deps.db, storeId, async (tx) => {
            return tx
              .select({
                customerId: customerMetrics.customerId,
                email: shopifyCustomers.email,
                firstName: shopifyCustomers.firstName,
                lastName: shopifyCustomers.lastName,
                ordersCount: customerMetrics.ordersCount,
                totalSpentCents: customerMetrics.totalSpentCents,
                aovCents: customerMetrics.aovCents,
                lastOrderAt: customerMetrics.lastOrderAt,
              })
              .from(customerMetrics)
              .innerJoin(shopifyCustomers, eq(shopifyCustomers.id, customerMetrics.customerId))
              .where(eq(customerMetrics.storeId, storeId))
              .orderBy(desc(customerMetrics.totalSpentCents))
              .limit(limit);
          });
        });

      res.status(200).json(successEnvelope(getRequestContext(), rows));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
