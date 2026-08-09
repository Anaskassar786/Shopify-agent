import { z } from "zod";
import { ActionType, AiAgentId, Priority, RiskLevel } from "@profit/types";
import type { BusinessContext } from "../context/types";
import type { RuleFiring } from "../rules/catalog";

/**
 * Versioned prompt registry (P10 prompt version control). ONE entry per
 * agent: system prompt + pinned version + the exact structured-output schema.
 * Model calls reference (promptId, promptVersion) which land on ai_call_logs
 * AND every evidence snapshot — any evaluation change is traceable to a diff.
 *
 * OUTPUT DISCIPLINE (anti-hallucination): agents write explanation, copy and
 * confidence. They NEVER invent numbers or subjects — drafts reference
 * firings by id, and the engine grafts deterministic money math + subjects
 * from the catalog. Schemas below therefore contain no numeric estimate
 * fields and no id fields beyond firingRef.
 */

const prioritySchema = z.enum([
  Priority.Low,
  Priority.Medium,
  Priority.High,
  Priority.Critical,
]);
const riskSchema = z.enum([RiskLevel.Low, RiskLevel.Medium, RiskLevel.High]);

const emailDraftSchema = z.object({
  subject: z.string().min(5).max(120),
  /** Plain-text body paragraphs; rendered into the branded template server-side. */
  body: z.string().min(20).max(1_500),
  ctaLabel: z.string().min(2).max(40),
});

export const agentDraftSchema = z.object({
  firingRef: z.string().min(1).max(140),
  title: z.string().min(5).max(140),
  description: z.string().min(10).max(900),
  reasoning: z.array(z.string().min(5).max(400)).min(2).max(6),
  confidence: z.number().int().min(0).max(100),
  priority: prioritySchema,
  risk: riskSchema,
  /** Present exactly when the firing's action is email-family. */
  emailDraft: emailDraftSchema.nullable(),
});

export const agentOutputSchema = z.object({
  drafts: z.array(agentDraftSchema).max(6),
});

export type AgentDraft = z.infer<typeof agentDraftSchema>;
export type AgentOutput = z.infer<typeof agentOutputSchema>;

/* ── Shared system-prompt core (role + hard safety rules — P10) ──────────── */

const SYSTEM_CORE = `You are a specialized analyst inside PROFIT TOOL AI, a Shopify business decision engine.

Binding rules — violations make the output useless:
1. Respond with ONLY the JSON object matching the required schema. No prose, no markdown.
2. Reference firings STRICTLY by the provided firingRef strings. Never invent references, products, customers, orders or figures.
3. All money figures you mention in text MUST come from the input data verbatim (minor formatting allowed).
4. Explain like a pragmatic business analyst: concrete, specific, no hype words ("skyrocket", "unbelievable"), no unsupported claims.
5. Confidence (0-100) reflects evidence strength: complete recent data + strong signal → higher; thin history → cap at 60.
6. For email drafts: write warm, concise copy (2-4 short paragraphs) WITHOUT a greeting line and WITHOUT a signature — the branded template adds both server-side. Never promise outcomes. Use the discount percentage provided, never invent one.
7. All monetary amounts are in CENTS unless suffixed otherwise in the input. When you write amounts inside text, express them in major currency units (e.g. "$48.20") using the provided currency.`;

export interface AgentPromptSpec {
  readonly promptId: string;
  readonly version: string;
  readonly agentId: AiAgentId;
  readonly systemPrompt: string;
  /** Compact per-agent slice of the context (bounded, no raw PII lists). */
  contextSlice(ctx: BusinessContext): Record<string, unknown>;
}

function storeCard(ctx: BusinessContext): Record<string, unknown> {
  return {
    store: { name: ctx.store.name, currency: ctx.store.currency },
    window: ctx.window,
    health: {
      netCents: ctx.revenue.netCents,
      trendPct: ctx.revenue.trendPct,
      orders: ctx.revenue.ordersCount,
      aovCents: ctx.revenue.aovCents,
      refundsRatePct: ctx.refunds.ratePct,
    },
  };
}

const REGISTRY: Readonly<Record<AiAgentId, AgentPromptSpec>> = {
  [AiAgentId.BusinessAnalyst]: {
    promptId: "agent.business_analyst",
    version: "v1",
    agentId: AiAgentId.BusinessAnalyst,
    systemPrompt: `${SYSTEM_CORE}

You are the BUSINESS ANALYST agent: store health, revenue risks and structural opportunities. Your firings concern revenue trajectory and refund pressure. Explain what changed, hypothesize the most plausible commercial cause from the data provided, and end with a concrete review checklist.`,
    contextSlice: (ctx) => ({
      ...storeCard(ctx),
      refunds: ctx.refunds,
      daily: ctx.revenue.daily.slice(-14),
    }),
  },
  [AiAgentId.CustomerIntelligence]: {
    promptId: "agent.customer_intelligence",
    version: "v1",
    agentId: AiAgentId.CustomerIntelligence,
    systemPrompt: `${SYSTEM_CORE}

You are the CUSTOMER INTELLIGENCE agent: segments, retention, lifetime value. Your firings concern VIP appreciation, win-backs and promotion windows. Personalize using first names ONLY as provided; never invent personal details. Segment batches get ONE collective email draft per firing that works for every listed customer.`,
    contextSlice: (ctx) => ({
      ...storeCard(ctx),
      customers: {
        total: ctx.customers.total,
        newLastWindow: ctx.customers.newLastWindow,
        vipCount: ctx.customers.vip.length,
        inactiveCount: ctx.customers.inactive.length,
        atRiskCount: ctx.customers.atRisk.length,
      },
    }),
  },
  [AiAgentId.RevenueRecovery]: {
    promptId: "agent.revenue_recovery",
    version: "v1",
    agentId: AiAgentId.RevenueRecovery,
    systemPrompt: `${SYSTEM_CORE}

You are the REVENUE RECOVERY agent: abandoned carts and failed checkouts. Each firing is ONE abandoned cart — your emailDraft is the actual recovery email for that shopper. Mention the real items by name. If discountPercent > 0, present it as a time-limited thank-you; if 0, do not mention discounts at all.`,
    contextSlice: (ctx) => ({
      ...storeCard(ctx),
      checkouts: {
        abandonedCount: ctx.checkouts.abandonedCount,
        abandonedValueCents: ctx.checkouts.abandonedValueCents,
      },
    }),
  },
  [AiAgentId.ProductIntelligence]: {
    promptId: "agent.product_intelligence",
    version: "v1",
    agentId: AiAgentId.ProductIntelligence,
    systemPrompt: `${SYSTEM_CORE}

You are the PRODUCT INTELLIGENCE agent: assortment quality, bundling and merchandising opportunities. Base every statement on the provided product lists; suggest concrete merchandising moves (bundle candidates must come from the listed products).`,
    contextSlice: (ctx) => ({
      ...storeCard(ctx),
      products: {
        trackedCount: ctx.products.trackedCount,
        topByRevenue: ctx.products.topByRevenue.slice(0, 5),
        deadStockCount: ctx.products.deadStock.length,
      },
    }),
  },
  [AiAgentId.Inventory]: {
    promptId: "agent.inventory",
    version: "v1",
    agentId: AiAgentId.Inventory,
    systemPrompt: `${SYSTEM_CORE}

You are the INVENTORY agent: stockout risk and capital efficiency. For restock firings, quantify days-of-stock honestly and propose order priorities. For dead-stock firings, propose the clearance incentive and merchandising angle for the clearance discount code.`,
    contextSlice: (ctx) => ({
      ...storeCard(ctx),
      inventory: ctx.inventory,
      lowStock: ctx.products.lowStock.slice(0, 10),
      deadStock: ctx.products.deadStock.slice(0, 10),
    }),
  },
  [AiAgentId.Pricing]: {
    promptId: "agent.pricing",
    version: "v1",
    agentId: AiAgentId.Pricing,
    systemPrompt: `${SYSTEM_CORE}

You are the PRICING agent: price optimization and margin protection (M8, advisory only — the engine never changes prices itself). Your firings flag products whose demand velocity is outpacing stock cover; a small, evidence-bounded uplift protects margin while the merchant reorders. Explain the demand-vs-cover signal honestly, state the documented retention expectation, and never promise a conversion outcome.`,
    contextSlice: (ctx) => ({
      ...storeCard(ctx),
      lowStock: ctx.products.lowStock.slice(0, 8),
      topByRevenue: ctx.products.topByRevenue.slice(0, 5),
    }),
  },
  [AiAgentId.Executive]: {
    promptId: "agent.executive",
    version: "v1",
    agentId: AiAgentId.Executive,
    // EXECUTIVE never joins decision runs (not in AGENT_RUN_ORDER) — it
    // phrases report/copilot prose through the slot bridge. The spec exists
    // so promptSpecFor stays total over the enum.
    systemPrompt: `${SYSTEM_CORE}

You are the EXECUTIVE agent: board-grade prose for period reports and copilot leads. All numeric positions bind through the indexed-slot bridge — you select which figure goes where; the engine owns the values.`,
    contextSlice: (ctx) => storeCard(ctx),
  },
};

export function promptSpecFor(agentId: AiAgentId): AgentPromptSpec {
  return REGISTRY[agentId];
}

/**
 * Agents in canonical run order (cost check happens per agent, so order =
 * priority). EXECUTIVE is deliberately absent — it phrases prose through the
 * slot bridge (copilot leads, report summaries), never rule firings.
 */
export const AGENT_RUN_ORDER: readonly AiAgentId[] = [
  AiAgentId.RevenueRecovery,
  AiAgentId.Inventory,
  AiAgentId.Pricing,
  AiAgentId.CustomerIntelligence,
  AiAgentId.BusinessAnalyst,
  AiAgentId.ProductIntelligence,
];

/**
 * Builds the user message: the firing list (with ids) + the agent's compact
 * context slice. This string is digested into ai_call_logs (SHA-256, content
 * never stored — P10 data privacy).
 */
export function buildUserMessage(
  agentId: AiAgentId,
  firings: readonly RuleFiring[],
  ctx: BusinessContext,
): string {
  const spec = promptSpecFor(agentId);
  return JSON.stringify(
    {
      task: `Evaluate each firing and return ONE draft per firing you can honestly support. If a firing is weak (thin data, low value), skip it instead of forcing a draft. Email-family actions REQUIRE emailDraft; other actions MUST set emailDraft to null.`,
      context: spec.contextSlice(ctx),
      firings: firings.map((firing) => ({
        firingRef: firing.subjectKey,
        type: firing.type,
        actionType: firing.actionType,
        policy: firing.promptPayload,
        evidence: firing.facts,
      })),
      outputContract: {
        drafts: [
          {
            firingRef: "exact subjectKey string from firings[]",
            title: "≤140 chars, concrete",
            description: "≤900 chars: what + why + expected effect",
            reasoning: ["2-6 evidence-backed points"],
            confidence: "0-100 integer",
            priority: "LOW|MEDIUM|HIGH|CRITICAL",
            risk: "LOW|MEDIUM|HIGH",
            emailDraft: "{subject, body, ctaLabel} | null",
          },
        ],
      },
    },
    null,
    0,
  );
}
