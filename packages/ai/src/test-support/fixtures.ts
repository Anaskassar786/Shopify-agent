import type { AiGenerateRequest, AiGenerateResult, AiProvider } from "../provider/port";
import type { ModelTier } from "@profit/types";
import { AiProviderId } from "@profit/types";
import type { BusinessContext } from "../context/types";

/**
 * Test doubles for the AI boundary. The scripted provider implements the REAL
 * port (not a subclass hack) so decision-service tests exercise production
 * orchestration end-to-end; the network edge (fetch) is the only stub, same
 * rule as the Shopify suites.
 */

export interface ScriptedReply {
  readonly match: (request: AiGenerateRequest<unknown>) => boolean;
  readonly output: unknown;
  readonly error?: Error;
}

export class ScriptedProvider implements AiProvider {
  readonly id = AiProviderId.Gemini;
  readonly calls: { agentId: string; promptId: string }[] = [];

  constructor(private readonly replies: readonly ScriptedReply[] = []) {}

  modelFor(_tier: ModelTier): string {
    return "gemini-test-model";
  }

  async generate<TOutput>(request: AiGenerateRequest<TOutput>): Promise<AiGenerateResult<TOutput>> {
    this.calls.push({ agentId: request.agentId, promptId: request.promptId });
    const reply = this.replies.find((candidate) => candidate.match(request as AiGenerateRequest<unknown>));
    if (reply === undefined) throw new Error(`scripted provider: no reply for ${request.agentId}`);
    if (reply.error !== undefined) throw reply.error;
    const output = request.outputSchema.parse(reply.output) as TOutput;
    return {
      output,
      rawJson: JSON.stringify(output),
      model: "gemini-test-model",
      usage: { inputTokens: 900, outputTokens: 220, costMicros: 187, latencyMs: 420 },
    };
  }
}

/** Baseline empty context — every builder override merges on top. */
export function makeContext(overrides: Partial<BusinessContext> = {}): BusinessContext {
  const base: BusinessContext = {
    store: { id: "store-1", name: "Demo Store", currency: "USD", countryCode: null },
    window: { daysAnalyzed: 30, from: "2026-07-06", to: "2026-08-05" },
    revenue: {
      windowDays: 30,
      netCents: 500_000,
      grossCents: 550_000,
      discountsCents: 30_000,
      refundsCents: 0,
      priorNetCents: 450_000,
      trendPct: 11,
      ordersCount: 120,
      cancelledCount: 0,
      aovCents: 4_166,
      daily: [{ date: "2026-08-04", netCents: 20_000, orders: 4 }],
    },
    customers: { total: 200, newLastWindow: 18, vip: [], inactive: [], atRisk: [] },
    products: { trackedCount: 40, topByRevenue: [], lowStock: [], deadStock: [] },
    checkouts: { abandonedCount: 0, abandonedValueCents: 0, abandoned: [] },
    refunds: { count: 0, cents: 0, ratePct: 0 },
    inventory: { trackedVariants: 60, outOfStock: 0, lowStock: 0 },
    policy: {
      mode: "MANUAL",
      abandonedCartEnabled: true,
      abandonedCartDelayHours: 6,
      abandonedCartMinValueCents: 0,
      abandonedCartDiscountPercent: 10,
      maxAutoDiscountPercent: 20,
      maxAutoApproveEstimatedRevenueCents: 100_000,
    },
    learning: {
      generatedTotal: 0,
      acceptedTotal: 0,
      rejectedTotal: 0,
      acceptanceRatePct: null,
      attributedRevenueCents: 0,
      attributedOrders: 0,
    },
    computedAt: "2026-08-05T12:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    store: { ...base.store, ...(overrides.store ?? {}) },
    window: { ...base.window, ...(overrides.window ?? {}) },
    revenue: { ...base.revenue, ...(overrides.revenue ?? {}) },
    customers: { ...base.customers, ...(overrides.customers ?? {}) },
    products: { ...base.products, ...(overrides.products ?? {}) },
    checkouts: { ...base.checkouts, ...(overrides.checkouts ?? {}) },
    refunds: { ...base.refunds, ...(overrides.refunds ?? {}) },
    inventory: { ...base.inventory, ...(overrides.inventory ?? {}) },
    policy: { ...base.policy, ...(overrides.policy ?? {}) },
    learning: { ...base.learning, ...(overrides.learning ?? {}) },
  };
}

export function makeAgentDraft(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    firingRef: "cart:token-1",
    title: "Recover the abandoned Alpha Runner cart",
    description: "A shopper left a $96.00 cart 9 hours ago. A timely, personal recovery email is the highest-ROI follow-up.",
    reasoning: [
      "Cart value ($96.00) is well above the store's average order value",
      "Nine hours is inside the proven recovery window",
    ],
    confidence: 82,
    priority: "HIGH",
    risk: "LOW",
    emailDraft: {
      subject: "Still thinking it over? Your cart is waiting",
      body: "Your Alpha Runner pair is still set aside for you.\n\nCarts this good rarely wait long — complete your order while your size is in stock.",
      ctaLabel: "Complete my order",
    },
    ...overrides,
  };
}
