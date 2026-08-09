import { describe, expect, it } from "vitest";
import { CopilotIntent, ForecastMethod } from "@profit/types";
import { AiProviderError } from "../provider/port";
import { ScriptedProvider } from "../test-support/fixtures";
import { composeAnswer, renderAnswer, COPILOT_LEAD_PROMPT } from "./composer";
import type { CopilotEvidence } from "./evidence";

function makeEvidence(overrides: Partial<CopilotEvidence> = {}): CopilotEvidence {
  return {
    intent: CopilotIntent.RevenueSummary,
    matchedPattern: "recent-revenue-totals",
    headline: "Last 30 days: $12,300.00 net across 120 orders (+8% vs the previous window).",
    bullets: ["Gross $13,000.00 · discounts $500.00.", "Average order value: $102.50."],
    tables: [
      {
        title: "Daily net sales — last 2 days",
        columns: ["Date", "Net sales", "Orders"],
        rows: [
          ["2026-08-06", "$400.00", "4"],
          ["2026-08-07", "$410.00", "4"],
        ],
      },
    ],
    recommendationRefs: [{ id: "rec-1", title: "Restock the fast movers", type: "RESTOCK" }],
    method: ForecastMethod.RevenueWeeklySeasonalityV1,
    confidence: 82,
    currency: "USD",
    windowLabel: "2026-07-09 → 2026-08-08",
    ...overrides,
  };
}

describe("deterministic renderer", () => {
  it("renders lead, bullets, markdown tables and the evidence footer", () => {
    const text = renderAnswer(makeEvidence(), "Lead sentence here.");
    expect(text).toContain("Lead sentence here.");
    expect(text).toContain("- Gross $13,000.00 · discounts $500.00.");
    expect(text).toContain("| Date | Net sales | Orders |");
    expect(text).toContain("| 2026-08-06 | $400.00 | 4 |");
    expect(text).toContain("method revenue.weekly-seasonality.v1");
    expect(text).toContain("confidence 82/100");
    expect(text).toContain("1 open action linked");
  });
});

describe("composeAnswer — provider contract (ADR 32)", () => {
  it("provider absent ⇒ deterministic answer, zero counted calls", async () => {
    const answer = await composeAnswer(null, "how were sales?", makeEvidence());
    expect(answer.modelEnhanced).toBe(false);
    expect(answer.aiCalls).toBe(0);
    expect(answer.text).toContain("$12,300.00");
  });

  it("provider success with indexed slots ⇒ polished lead, one counted call", async () => {
    const provider = new ScriptedProvider([{
      match: (req) => req.promptId === COPILOT_LEAD_PROMPT.promptId,
      output: { lead: "Across {N3} orders the last {N1} days brought {N2} net, trending {N4}." },
    }]);
    const answer = await composeAnswer(provider, "how were sales?", makeEvidence());
    // Headline tokens: $12,300.00 / 30 / 120 / +8%
    expect(answer.modelEnhanced).toBe(true);
    expect(answer.aiCalls).toBe(1);
    expect(answer.costMicros).toBe(187);
    expect(answer.lead).toBe("Across 120 orders the last 30 days brought $12,300.00 net, trending +8%.");
    expect(provider.calls).toHaveLength(1);
  });

  it("digit-smuggling drafts are rejected — deterministic lead ships instead", async () => {
    const provider = new ScriptedProvider([{
      match: () => true,
      output: { lead: "Sales exploded 999% to $12,300.00 in days!" },
    }]);
    const answer = await composeAnswer(provider, "how were sales?", makeEvidence());
    expect(answer.modelEnhanced).toBe(false);
    expect(answer.lead).toContain("$12,300.00 net across 120 orders");
  });

  it("provider errors fall back silently (first-class outcome)", async () => {
    const provider = new ScriptedProvider([{
      match: () => true,
      output: {},
      error: new AiProviderError("RATE_LIMITED", "quota", true),
    }]);
    const answer = await composeAnswer(provider, "how were sales?", makeEvidence());
    expect(answer.modelEnhanced).toBe(false);
    expect(answer.aiCalls).toBe(0);
  });

  it("headlines without figures stay deterministic (nothing to protect)", async () => {
    const provider = new ScriptedProvider([]);
    const answer = await composeAnswer(
      provider,
      "hello",
      makeEvidence({ intent: CopilotIntent.GeneralOther, headline: "I answer from your store's real numbers." }),
    );
    expect(answer.modelEnhanced).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });
});
