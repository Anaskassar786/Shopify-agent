import { describe, expect, it } from "vitest";
import { Priority, RiskLevel } from "@profit/types";
import { calibrateConfidence, finalizePriority, finalizeRisk, scoreDrafts } from "./scoring";
import { makeAgentDraft, makeContext } from "./test-support/fixtures";
import { evaluateRules } from "./rules/catalog";
import type { AgentDraft } from "./prompts/registry";

/**
 * Server-side calibration contract (P10 guardrails): model scores are
 * proposals; the engine decides — data dampeners, learning adjuster,
 * priority/risk ceilings, and firingRef validation.
 */

describe("calibrateConfidence", () => {
  it("passes strong scores through on rich data", () => {
    const { confidence, tier } = calibrateConfidence(92, makeContext());
    expect(confidence).toBe(92);
    expect(tier).toBe("HIGH");
  });

  it("dampens thin data to a conservative cap", () => {
    const ctx = makeContext({
      revenue: { ...makeContext().revenue, ordersCount: 3 },
    });
    const { confidence, tier } = calibrateConfidence(95, ctx);
    expect(confidence).toBe(55);
    expect(tier).toBe("NEEDS_REVIEW");
  });

  it("customer-thin stores cap at 65", () => {
    const ctx = makeContext({ customers: { ...makeContext().customers, total: 2 } });
    expect(calibrateConfidence(90, ctx).confidence).toBe(65);
  });

  it("learning adjuster scales by merchant acceptance after 5+ decisions", () => {
    const ctx = makeContext({
      learning: {
        generatedTotal: 10,
        acceptedTotal: 1,
        rejectedTotal: 9,
        acceptanceRatePct: 10,
        attributedRevenueCents: 0,
        attributedOrders: 0,
      },
    });
    // 10% acceptance → factor 0.8 + 10/500 = 0.82 → 90 * 0.82 = 73.8 → 74
    expect(calibrateConfidence(90, ctx).confidence).toBe(74);
  });

  it("never leaves 0-100 bounds", () => {
    expect(calibrateConfidence(-20, makeContext()).confidence).toBe(0);
    expect(calibrateConfidence(10_000, makeContext()).confidence).toBe(100);
  });
});

describe("finalizePriority / finalizeRisk", () => {
  it("rule base is the floor; model raises ≤1 rank, never to CRITICAL", () => {
    expect(finalizePriority(Priority.High, Priority.Medium)).toBe(Priority.High);
    expect(finalizePriority(Priority.Critical, Priority.Low)).toBe(Priority.Medium);
    expect(finalizePriority(Priority.Critical, Priority.Critical)).toBe(Priority.Critical);
    // Model caution cannot demote below the deterministic rule floor.
    expect(finalizePriority(Priority.Low, Priority.High)).toBe(Priority.High);
  });

  it("risk takes the conservative (higher) side", () => {
    expect(finalizeRisk(RiskLevel.Low, RiskLevel.High)).toBe(RiskLevel.High);
    expect(finalizeRisk(RiskLevel.High, RiskLevel.Low)).toBe(RiskLevel.High);
    expect(finalizeRisk(RiskLevel.Medium, RiskLevel.Medium)).toBe(RiskLevel.Medium);
  });
});

describe("scoreDrafts", () => {
  function firingSet() {
    const ctx = makeContext({
      checkouts: {
        abandonedCount: 1,
        abandonedValueCents: 9_600,
        abandoned: [{
          token: "token-1", customerId: null, firstName: "Mia", hasEmail: true, totalCents: 9_600,
          currency: "USD", itemCount: 1, itemsPreview: [], webUrl: "https://x", createdAt: "2026-08-05T00:00:00Z", hoursAgo: 9,
        }],
      },
    });
    return { ctx, firings: evaluateRules(ctx) };
  }

  it("scores drafts against their firing and keeps deterministic numbers server-side", () => {
    const { ctx, firings } = firingSet();
    const draft = { ...makeAgentDraft(), firingRef: "cart:token-1" } as unknown as AgentDraft;
    const { scored, droppedRefs } = scoreDrafts(firings, [draft], ctx);
    expect(droppedRefs).toHaveLength(0);
    expect(scored).toHaveLength(1);
    expect(scored[0]?.firing.estimatedRevenueCents).toBeGreaterThan(0);
    expect(scored[0]?.confidence).toBeLessThanOrEqual(100);
  });

  it("drops unknown firingRefs, duplicates and missing email drafts", () => {
    const { ctx, firings } = firingSet();
    const valid = { ...makeAgentDraft(), firingRef: "cart:token-1" } as unknown as AgentDraft;
    const unknown = { ...makeAgentDraft(), firingRef: "cart:nope" } as unknown as AgentDraft;
    const dup = { ...makeAgentDraft(), firingRef: "cart:token-1", title: "Dup" } as unknown as AgentDraft;
    const noEmail = { ...makeAgentDraft(), firingRef: "cart:token-1", emailDraft: null } as unknown as AgentDraft;
    const { scored, droppedRefs } = scoreDrafts(
      firings,
      [unknown, valid, dup, noEmail].map((d, i) => ({ ...d, title: `${d.title} ${i}` })),
      ctx,
    );
    expect(scored).toHaveLength(1);
    expect(droppedRefs).toHaveLength(3);
  });
});
