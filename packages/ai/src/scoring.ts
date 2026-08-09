import { Priority, RiskLevel } from "@profit/types";
import type { BusinessContext } from "./context/types";
import type { RuleFiring } from "./rules/catalog";
import type { AgentDraft } from "./prompts/registry";

/**
 * Server-side calibration (P10 confidence tiers + guardrails). The model
 * PROPOSES confidence/priority/risk; the engine decides them deterministically:
 *
 *  - confidence: model score clamped by data completeness, then scaled by the
 *    merchant's historical acceptance (learning loop) — thin evidence can
 *    never masquerade as certainty;
 *  - priority: model may raise the rule's base by ONE rank, never to CRITICAL
 *    unless the rule already said CRITICAL;
 *  - risk: final risk is the HIGHER of model vs rule — conservative wins.
 */

export type ConfidenceTier = "HIGH" | "MEDIUM" | "NEEDS_REVIEW";

const RANK: Readonly<Record<Priority, number>> = {
  [Priority.Low]: 0,
  [Priority.Medium]: 1,
  [Priority.High]: 2,
  [Priority.Critical]: 3,
};
const RISK_RANK: Readonly<Record<RiskLevel, number>> = {
  [RiskLevel.Low]: 0,
  [RiskLevel.Medium]: 1,
  [RiskLevel.High]: 2,
};
const PRIORITY_BY_RANK: readonly Priority[] = [
  Priority.Low,
  Priority.Medium,
  Priority.High,
  Priority.Critical,
];
const RISK_BY_RANK: readonly RiskLevel[] = [RiskLevel.Low, RiskLevel.Medium, RiskLevel.High];

export function calibrateConfidence(
  modelConfidence: number,
  ctx: BusinessContext,
): { readonly confidence: number; readonly tier: ConfidenceTier } {
  let value = Math.min(Math.max(Math.round(modelConfidence), 0), 100);

  // Data completeness dampener — young stores get honest, conservative scores.
  if (ctx.revenue.ordersCount < 10) value = Math.min(value, 55);
  else if (ctx.customers.total < 5) value = Math.min(value, 65);

  // Learning loop: acceptance history scales future confidence (bounded ±20%).
  const decided = ctx.learning.acceptedTotal + ctx.learning.rejectedTotal;
  if (decided >= 5 && ctx.learning.acceptanceRatePct !== null) {
    const factor = 0.8 + ctx.learning.acceptanceRatePct / 500; // 0.8 … 1.0
    value = Math.round(value * factor);
  }

  value = Math.min(Math.max(value, 0), 100);
  const tier: ConfidenceTier = value >= 90 ? "HIGH" : value >= 70 ? "MEDIUM" : "NEEDS_REVIEW";
  return { confidence: value, tier };
}

export function finalizePriority(model: Priority, ruleBase: Priority): Priority {
  const baseRank = RANK[ruleBase];
  // Rule base is the FLOOR; the model may raise by at most one rank, and
  // CRITICAL is reachable only when the deterministic rule asserted it.
  const modelRank = Math.max(baseRank, Math.min(RANK[model], baseRank + 1));
  const capped =
    ruleBase === Priority.Critical ? modelRank : Math.min(modelRank, RANK[Priority.High]);
  return PRIORITY_BY_RANK[capped] ?? ruleBase;
}

export function finalizeRisk(model: RiskLevel, ruleBase: RiskLevel): RiskLevel {
  const rank = Math.max(RISK_RANK[model], RISK_RANK[ruleBase]);
  return RISK_BY_RANK[rank] ?? ruleBase;
}

export interface ScoredDraft {
  readonly firing: RuleFiring;
  readonly draft: AgentDraft;
  readonly confidence: number;
  readonly tier: ConfidenceTier;
  readonly priority: Priority;
  readonly risk: RiskLevel;
}

/** Pairs validated model drafts with their firings and scores them. Unknown firingRefs vanish here. */
export function scoreDrafts(
  firings: readonly RuleFiring[],
  drafts: readonly AgentDraft[],
  ctx: BusinessContext,
): { readonly scored: readonly ScoredDraft[]; readonly droppedRefs: readonly string[] } {
  const byRef = new Map(firings.map((firing) => [firing.subjectKey, firing]));
  const scored: ScoredDraft[] = [];
  const dropped: string[] = [];
  const seenRefs = new Set<string>();
  for (const draft of drafts) {
    const firing = byRef.get(draft.firingRef);
    if (firing === undefined || seenRefs.has(draft.firingRef)) {
      dropped.push(draft.firingRef);
      continue;
    }
    seenRefs.add(draft.firingRef);
    // Email-family firings REQUIRE copy; copy on non-email firings is dropped.
    if (firing.actionType === "SEND_RECOVERY_EMAIL" && draft.emailDraft === null) {
      dropped.push(draft.firingRef);
      continue;
    }
    const { confidence, tier } = calibrateConfidence(draft.confidence, ctx);
    scored.push({
      firing,
      draft,
      confidence,
      tier,
      priority: finalizePriority(draft.priority, firing.basePriority),
      risk: finalizeRisk(draft.risk, firing.baseRisk),
    });
  }
  return { scored, droppedRefs: dropped };
}
