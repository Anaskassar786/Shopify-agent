import {
  ActionType,
  AiAgentId,
  Priority,
  RecommendationType,
  RiskLevel,
} from "@profit/types";
import type { BusinessContext } from "../context/types";

/**
 * Built-in rule catalog (P3 rule engine, BEFORE-AI stage). Every rule is a
 * PURE function over BusinessContext: same input ⇒ same firings, always.
 *
 * DESIGN INVARIANT (anti-hallucination): the numbers a merchant acts on —
 * estimated revenue, subjects, evidence metrics — come from THIS layer, not
 * from the model. The model explains, personalizes and scores confidence;
 * the catalog owns the money math.
 *
 * Estimates are conservative, documented expectation constants per rule.
 * Version bumps force re-dedupe (fingerprint carries ruleVersion).
 */

export interface RuleFiring {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly agentId: AiAgentId;
  readonly type: RecommendationType;
  readonly actionType: ActionType;
  /** Stable subject key for dedupe (single token, segment+ISO week, ...). */
  readonly subjectKey: string;
  /** Explainable data pins — rendered in evidence + available to tools. */
  readonly subjects: {
    readonly checkoutTokens?: readonly string[];
    readonly customerIds?: readonly string[];
    readonly productIds?: readonly string[];
  };
  /** Deterministic money estimates in cents (documented expectation constants). */
  readonly estimatedRevenueCents: number;
  readonly estimatedCostCents: number;
  readonly basePriority: Priority;
  readonly baseRisk: RiskLevel;
  /** Human-auditable evidence facts — the "which data was used" answer. */
  readonly facts: readonly string[];
  /** Compact payload the agent sees (bounded; no PII beyond first names). */
  readonly promptPayload: Record<string, unknown>;
  /** Server-side execution parameters template (merchant-policy-bound). */
  readonly executionTemplate: Record<string, unknown>;
  /** Open recommendations older than this re-offer after resolution. */
  readonly expiresInDays: number;
}

export interface RuleDefinition {
  readonly id: string;
  readonly version: number;
  readonly agentId: AiAgentId;
  readonly type: RecommendationType;
  evaluate(ctx: BusinessContext): readonly RuleFiring[];
}

/** ISO week bucket — batch recommendations re-offer weekly after resolution. */
function isoWeekKey(dateIso: string): string {
  const date = new Date(dateIso);
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date.getTime() - day * 86_400_000 + 3 * 86_400_000);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/* Expectation constants — conservative on purpose (P11 credibility). */
export const EXPECTATIONS = {
  /** Share of recovered-cart value a good recovery email flow realizes. */
  cartRecoveryRate: 0.12,
  /** Realization expectation on a targeted win-back batch. */
  winbackRate: 0.05,
  /** VIP appreciation offers historically re-activate a slice of LTV. */
  vipOfferRate: 0.08,
  /** Clearance discount converts a fraction of dead-stock value. */
  deadStockClearanceRate: 0.25,
  /** Restocking prevents losing the next N days of velocity (14-day horizon). */
  restockHorizonDays: 14,
  /** Momentum promotion lifts the next 7 days a few percent. */
  promotionLiftRate: 0.04,
} as const;

const MAX_CART_RECOVERIES_PER_RUN = 5;
const MAX_EMAIL_BATCH = 5;

const abandonedCartsRule: RuleDefinition = {
  id: "cart.abandoned-recovery",
  version: 1,
  agentId: AiAgentId.RevenueRecovery,
  type: RecommendationType.RecoverAbandonedCart,
  evaluate(ctx) {
    if (!ctx.policy.abandonedCartEnabled) return [];
    return ctx.checkouts.abandoned
      .filter(
        (cart) =>
          cart.hasEmail &&
          cart.hoursAgo >= ctx.policy.abandonedCartDelayHours &&
          cart.totalCents >= ctx.policy.abandonedCartMinValueCents &&
          cart.webUrl !== null,
      )
      .slice(0, MAX_CART_RECOVERIES_PER_RUN)
      .map((cart) => {
        const discountCents = Math.round(
          (cart.totalCents * ctx.policy.abandonedCartDiscountPercent) / 100,
        );
        const itemsText = cart.itemsPreview
          .map((item) => `${item.quantity}× ${item.title}`)
          .join(", ");
        return {
          ruleId: abandonedCartsRule.id,
          ruleVersion: abandonedCartsRule.version,
          agentId: abandonedCartsRule.agentId,
          type: abandonedCartsRule.type,
          actionType: ActionType.SendRecoveryEmail,
          subjectKey: `cart:${cart.token}`,
          subjects: {
            checkoutTokens: [cart.token],
            ...(cart.customerId !== null ? { customerIds: [cart.customerId] } : {}),
          },
          estimatedRevenueCents: Math.round(cart.totalCents * EXPECTATIONS.cartRecoveryRate),
          estimatedCostCents: discountCents,
          basePriority:
            cart.totalCents >= 10_000
              ? Priority.High
              : cart.totalCents >= 4_000
                ? Priority.Medium
                : Priority.Low,
          baseRisk: RiskLevel.Low,
          facts: [
            `Cart worth ${(cart.totalCents / 100).toFixed(2)} ${cart.currency} abandoned ${cart.hoursAgo}h ago`,
            `Contents: ${itemsText || `${cart.itemCount} item(s)`}`,
            `Recovery trend baseline: ${Math.round(EXPECTATIONS.cartRecoveryRate * 100)}% of cart value`,
            ctx.policy.abandonedCartDiscountPercent > 0
              ? `Merchant-approved incentive: ${ctx.policy.abandonedCartDiscountPercent}% off`
              : "No discount incentive configured",
          ],
          promptPayload: {
            cart: {
              firstName: cart.firstName,
              totalCents: cart.totalCents,
              currency: cart.currency,
              items: cart.itemsPreview,
              itemCount: cart.itemCount,
              hoursAgo: cart.hoursAgo,
            },
            discountPercent: ctx.policy.abandonedCartDiscountPercent,
          },
          executionTemplate: {
            checkoutToken: cart.token,
            template: "RECOVERY",
            discountPercent: ctx.policy.abandonedCartDiscountPercent,
          },
          expiresInDays: 7,
        } satisfies RuleFiring;
      });
  },
};

const restockRule: RuleDefinition = {
  id: "inventory.stockout-risk",
  version: 1,
  agentId: AiAgentId.Inventory,
  type: RecommendationType.Restock,
  evaluate(ctx) {
    if (ctx.products.lowStock.length === 0) return [];
    const subjects = ctx.products.lowStock.slice(0, 10);
    // Value protected by restocking = next 14 days of velocity sales per product.
    const atRiskCents = subjects.reduce(
      (sum, p) => sum + Math.round(p.velocityPerDay * EXPECTATIONS.restockHorizonDays * p.priceCents),
      0,
    );
    return [{
      ruleId: restockRule.id,
      ruleVersion: restockRule.version,
      agentId: restockRule.agentId,
      type: restockRule.type,
      actionType: ActionType.Advisory,
      subjectKey: `restock:${isoWeekKey(ctx.computedAt)}`,
      subjects: { productIds: subjects.map((p) => p.id) },
      estimatedRevenueCents: atRiskCents,
      estimatedCostCents: 0,
      basePriority:
        ctx.products.lowStock.some((p) => p.daysOfStock <= 3) ? Priority.Critical : Priority.High,
      baseRisk: RiskLevel.Medium,
      facts: subjects.slice(0, 5).map(
        (p) =>
          `${p.title}: ${p.onHand} left, sells ~${p.velocityPerDay}/day → ~${p.daysOfStock} days of stock`,
      ).concat(
        ctx.products.lowStock.length > 5
          ? [`+${ctx.products.lowStock.length - 5} more products under 14 days of stock`]
          : [],
      ),
      promptPayload: {
        products: subjects.map((p) => ({
          title: p.title, onHand: p.onHand, velocityPerDay: p.velocityPerDay, daysOfStock: p.daysOfStock,
        })),
      },
      executionTemplate: { note: "advisory.restock" },
      expiresInDays: 7,
    }];
  },
};

const deadStockRule: RuleDefinition = {
  id: "inventory.dead-stock",
  version: 1,
  agentId: AiAgentId.Inventory,
  type: RecommendationType.RemoveDeadStock,
  evaluate(ctx) {
    if (ctx.products.deadStock.length === 0) return [];
    const subjects = ctx.products.deadStock.slice(0, 10);
    const stockValueCents = subjects.reduce((sum, p) => sum + p.onHand * p.priceCents, 0);
    const discountPercent = Math.min(25, ctx.policy.maxAutoDiscountPercent);
    return [{
      ruleId: deadStockRule.id,
      ruleVersion: deadStockRule.version,
      agentId: deadStockRule.agentId,
      type: deadStockRule.type,
      actionType: ActionType.CreateDiscountCode,
      subjectKey: `deadstock:${isoWeekKey(ctx.computedAt)}`,
      subjects: { productIds: subjects.map((p) => p.id) },
      estimatedRevenueCents: Math.round(stockValueCents * EXPECTATIONS.deadStockClearanceRate),
      estimatedCostCents: Math.round((stockValueCents * discountPercent) / 100),
      basePriority: Priority.Medium,
      baseRisk: RiskLevel.Low,
      facts: [
        `${subjects.length} products with zero sales in 30 days and ≥10 units on hand`,
        `Capital parked in dead stock: ${(stockValueCents / 100).toFixed(2)} ${ctx.store.currency}`,
        `Clearance expectation: ${Math.round(EXPECTATIONS.deadStockClearanceRate * 100)}% of stock value at ${discountPercent}% off`,
      ],
      promptPayload: {
        products: subjects.map((p) => ({ title: p.title, onHand: p.onHand, priceCents: p.priceCents, daysListed: p.daysListed })),
        discountPercent,
      },
      executionTemplate: { discountPercent, purpose: "CLEARANCE", expiresInDays: 14 },
      expiresInDays: 7,
    }];
  },
};

const vipRule: RuleDefinition = {
  id: "customers.vip-appreciation",
  version: 1,
  agentId: AiAgentId.CustomerIntelligence,
  type: RecommendationType.TargetVip,
  evaluate(ctx) {
    const eligible = ctx.customers.vip
      .filter((c) => c.daysSinceLastOrder !== null && c.daysSinceLastOrder <= 45)
      .slice(0, MAX_EMAIL_BATCH);
    if (eligible.length === 0) return [];
    const ltvSum = eligible.reduce((sum, c) => sum + c.ltvCents, 0);
    const discountPercent = Math.min(15, ctx.policy.maxAutoDiscountPercent);
    return [{
      ruleId: vipRule.id,
      ruleVersion: vipRule.version,
      agentId: vipRule.agentId,
      type: vipRule.type,
      actionType: ActionType.SendRecoveryEmail,
      subjectKey: `vip:${isoWeekKey(ctx.computedAt)}`,
      subjects: { customerIds: eligible.map((c) => c.id) },
      estimatedRevenueCents: Math.round(ltvSum * EXPECTATIONS.vipOfferRate),
      estimatedCostCents: Math.round((ltvSum / 10) * discountPercent / 100),
      basePriority: Priority.Medium,
      baseRisk: RiskLevel.Low,
      facts: [
        `${eligible.length} VIP customers (top lifetime value, recent buyers) identified`,
        `Combined lifetime value: ${(ltvSum / 100).toFixed(2)} ${ctx.store.currency}`,
      ],
      promptPayload: {
        customers: eligible.map((c) => ({ firstName: c.firstName, ltvCents: c.ltvCents, ordersCount: c.ordersCount })),
        discountPercent,
      },
      executionTemplate: { template: "VIP", discountPercent },
      expiresInDays: 7,
    }];
  },
};

const winbackRule: RuleDefinition = {
  id: "customers.winback-inactive",
  version: 1,
  agentId: AiAgentId.CustomerIntelligence,
  type: RecommendationType.WinbackInactive,
  evaluate(ctx) {
    const eligible = ctx.customers.inactive.slice(0, MAX_EMAIL_BATCH);
    if (eligible.length === 0) return [];
    const ltvSum = eligible.reduce((sum, c) => sum + c.ltvCents, 0);
    const discountPercent = Math.min(20, ctx.policy.maxAutoDiscountPercent);
    return [{
      ruleId: winbackRule.id,
      ruleVersion: winbackRule.version,
      agentId: winbackRule.agentId,
      type: winbackRule.type,
      actionType: ActionType.SendRecoveryEmail,
      subjectKey: `winback:${isoWeekKey(ctx.computedAt)}`,
      subjects: { customerIds: eligible.map((c) => c.id) },
      estimatedRevenueCents: Math.round(ltvSum * EXPECTATIONS.winbackRate),
      estimatedCostCents: Math.round((ltvSum / 10) * discountPercent / 100),
      basePriority: Priority.Medium,
      baseRisk: RiskLevel.Low,
      facts: eligible.slice(0, 3).map(
        (c) => `${c.firstName ?? "Customer"}: ${c.ordersCount} orders, quiet for ${c.daysSinceLastOrder ?? "?"} days`,
      ).concat(eligible.length > 3 ? [`+${eligible.length - 3} more inactive customers`] : []),
      promptPayload: {
        customers: eligible.map((c) => ({
          firstName: c.firstName, ordersCount: c.ordersCount, daysQuiet: c.daysSinceLastOrder, ltvCents: c.ltvCents,
        })),
        discountPercent,
      },
      executionTemplate: { template: "WINBACK", discountPercent },
      expiresInDays: 7,
    }];
  },
};

const refundRiskRule: RuleDefinition = {
  id: "revenue.refund-pressure",
  version: 1,
  agentId: AiAgentId.BusinessAnalyst,
  type: RecommendationType.ReduceRefundRisk,
  evaluate(ctx) {
    if (ctx.refunds.ratePct < 8 || ctx.refunds.cents < 5_000) return [];
    return [{
      ruleId: refundRiskRule.id,
      ruleVersion: refundRiskRule.version,
      agentId: refundRiskRule.agentId,
      type: refundRiskRule.type,
      actionType: ActionType.Advisory,
      subjectKey: `refunds:${isoWeekKey(ctx.computedAt)}`,
      subjects: {},
      estimatedRevenueCents: ctx.refunds.cents,
      estimatedCostCents: 0,
      basePriority: ctx.refunds.ratePct >= 15 ? Priority.High : Priority.Medium,
      baseRisk: RiskLevel.High,
      facts: [
        `${ctx.refunds.ratePct}% of 30-day gross sales value refunded (${ctx.refunds.count} orders)`,
        `Refund value: ${(ctx.refunds.cents / 100).toFixed(2)} ${ctx.store.currency}`,
      ],
      promptPayload: { ratePct: ctx.refunds.ratePct, cents: ctx.refunds.cents, count: ctx.refunds.count, currency: ctx.store.currency },
      executionTemplate: { note: "advisory.refund-review" },
      expiresInDays: 14,
    }];
  },
};

const revenueDeclineRule: RuleDefinition = {
  id: "revenue.decline-review",
  version: 1,
  agentId: AiAgentId.BusinessAnalyst,
  type: RecommendationType.RevenueDeclineReview,
  evaluate(ctx) {
    const trend = ctx.revenue.trendPct;
    // Fire only on a real decline with enough volume to matter (anti-noise floor).
    if (trend === null || trend > -15 || ctx.revenue.priorNetCents < 100_000) return [];
    const recent7 = ctx.revenue.daily.slice(-7).reduce((s, d) => s + d.netCents, 0);
    const previous7 = ctx.revenue.daily.slice(-14, -7).reduce((s, d) => s + d.netCents, 0);
    return [{
      ruleId: revenueDeclineRule.id,
      ruleVersion: revenueDeclineRule.version,
      agentId: revenueDeclineRule.agentId,
      type: revenueDeclineRule.type,
      actionType: ActionType.Advisory,
      subjectKey: `decline:${isoWeekKey(ctx.computedAt)}`,
      subjects: {},
      estimatedRevenueCents: Math.round((ctx.revenue.priorNetCents - ctx.revenue.netCents) / 2),
      estimatedCostCents: 0,
      basePriority: Priority.High,
      baseRisk: RiskLevel.Medium,
      facts: [
        `Net sales down ${Math.abs(trend)}% vs the previous ${ctx.revenue.windowDays}-day window`,
        `Last 7 days: ${(recent7 / 100).toFixed(0)} ${ctx.store.currency} vs ${(previous7 / 100).toFixed(0)} the week before`,
      ],
      promptPayload: {
        trendPct: trend,
        currentCents: ctx.revenue.netCents,
        priorCents: ctx.revenue.priorNetCents,
        recent7Cents: recent7,
        previous7Cents: previous7,
        currency: ctx.store.currency,
      },
      executionTemplate: { note: "advisory.revenue-review" },
      expiresInDays: 14,
    }];
  },
};

const promotionRule: RuleDefinition = {
  id: "growth.promotion-window",
  version: 1,
  agentId: AiAgentId.CustomerIntelligence,
  type: RecommendationType.LaunchPromotion,
  evaluate(ctx) {
    // Momentum promo: stable revenue, meaningful order volume, and repeat
    // customers to activate — an honest trigger, not a calendar gimmick.
    const trend = ctx.revenue.trendPct;
    if (trend === null || trend < -5) return [];
    if (ctx.revenue.ordersCount < 20) return [];
    if (ctx.customers.atRisk.length < 3) return [];
    const weeklyNet = Math.round((ctx.revenue.netCents / ctx.revenue.windowDays) * 7);
    const discountPercent = Math.min(10, ctx.policy.maxAutoDiscountPercent);
    return [{
      ruleId: promotionRule.id,
      ruleVersion: promotionRule.version,
      agentId: promotionRule.agentId,
      type: promotionRule.type,
      actionType: ActionType.CreateDiscountCode,
      subjectKey: `promo:${isoWeekKey(ctx.computedAt)}`,
      subjects: { customerIds: ctx.customers.atRisk.slice(0, 10).map((c) => c.id) },
      estimatedRevenueCents: Math.round(weeklyNet * EXPECTATIONS.promotionLiftRate),
      estimatedCostCents: Math.round((weeklyNet * EXPECTATIONS.promotionLiftRate * discountPercent) / 100),
      basePriority: Priority.Low,
      baseRisk: RiskLevel.Low,
      facts: [
        `${ctx.customers.atRisk.length} once-loyal customers are 30–60 days quiet`,
        `A short promotion window typically lifts a stable week by ${Math.round(EXPECTATIONS.promotionLiftRate * 100)}%`,
      ],
      promptPayload: {
        atRiskCount: ctx.customers.atRisk.length,
        aovCents: ctx.revenue.aovCents,
        discountPercent,
        currency: ctx.store.currency,
      },
      executionTemplate: { discountPercent, purpose: "PROMOTION", expiresInDays: 7 },
      expiresInDays: 7,
    }];
  },
};

/** The v1 catalog — one rule per recommendation type, all deterministic. */
export const RULE_CATALOG: readonly RuleDefinition[] = [
  abandonedCartsRule,
  restockRule,
  deadStockRule,
  vipRule,
  winbackRule,
  refundRiskRule,
  revenueDeclineRule,
  promotionRule,
];

export function evaluateRules(ctx: BusinessContext): readonly RuleFiring[] {
  return RULE_CATALOG.flatMap((rule) => rule.evaluate(ctx));
}

export function firingsByAgent(
  firings: readonly RuleFiring[],
  agentId: AiAgentId,
): readonly RuleFiring[] {
  return firings.filter((firing) => firing.agentId === agentId);
}
