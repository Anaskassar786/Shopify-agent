import { describe, expect, it } from "vitest";
import { ReportKind } from "@profit/types";
import { AiProviderError } from "../provider/port";
import { ScriptedProvider } from "../test-support/fixtures";
import {
  composeExecutiveSummary,
  EXECUTIVE_SUMMARY_PROMPT,
  renderDeterministicSummary,
  type ExecutiveSummaryInput,
} from "./executive";

const INPUT: ExecutiveSummaryInput = {
  storeName: "Demo Store",
  kind: ReportKind.Weekly,
  periodLabel: "Aug 2 – Aug 8, 2026",
  kpis: [
    { label: "Net sales", display: "$12,300.00", deltaPct: 8 },
    { label: "Orders", display: "120", deltaPct: -2 },
    { label: "Average order value", display: "$102.50", deltaPct: null },
  ],
  highlights: [
    "Forecast (revenue.weekly-seasonality.v1): $5,900.00 expected over the next 14 days.",
    "2 products face stockout within 14 days.",
  ],
};

describe("renderDeterministicSummary", () => {
  it("composes a factual paragraph with deltas from the KPI inputs", () => {
    const text = renderDeterministicSummary(INPUT);
    expect(text).toContain("Demo Store — weekly report for Aug 2 – Aug 8, 2026.");
    expect(text).toContain("Net sales: $12,300.00 — +8% vs the prior period");
    expect(text).toContain("Orders: 120 — -2% vs the prior period");
    expect(text).toContain("Average order value: $102.50");
    expect(text).toContain("$5,900.00 expected over the next 14 days");
  });
});

describe("composeExecutiveSummary — slot-bridge contract", () => {
  it("provider absent ⇒ deterministic paragraph, zero counted calls", async () => {
    const result = await composeExecutiveSummary(null, INPUT);
    expect(result.modelEnhanced).toBe(false);
    expect(result.aiCalls).toBe(0);
    expect(result.summary).toContain("$12,300.00");
  });

  it("provider success ⇒ slot-filled prose, one counted call", async () => {
    // Token stream from the deterministic paragraph (dates first):
    //   1:"2"  2:"8"  3:"2026"  4:"$12,300.00"  5:"+8%"  6:"120"  7:"-2%"
    //   8:"$102.50"  9:"1"(v1)  10:"$5,900.00"  11:"14"  12:"2"  13:"14"
    const provider = new ScriptedProvider([{
      match: (req) => req.promptId === EXECUTIVE_SUMMARY_PROMPT.promptId,
      output: { summary: "The week closed stronger: net sales reached {N4} ({N5} vs the prior period), and the model's two-week outlook holds {N10}. Watch the stockout watchlist before the next restock." },
    }]);
    const result = await composeExecutiveSummary(provider, INPUT);
    expect(result.modelEnhanced).toBe(true);
    expect(result.aiCalls).toBe(1);
    expect(result.summary).toContain("net sales reached $12,300.00 (+8% vs the prior period)");
    expect(result.summary).toContain("$5,900.00");
  });

  it("digit-smuggling or empty drafts fall back to the deterministic paragraph", async () => {
    const smuggler = new ScriptedProvider([{
      match: () => true,
      output: { summary: "Revenue doubled to $12,300.00 with 1000% growth this period." },
    }]);
    expect((await composeExecutiveSummary(smuggler, INPUT)).modelEnhanced).toBe(false);

    const failing = new ScriptedProvider([{
      match: () => true,
      output: {},
      error: new AiProviderError("TIMEOUT", "slow", true),
    }]);
    const result = await composeExecutiveSummary(failing, INPUT);
    expect(result.modelEnhanced).toBe(false);
    expect(result.summary).toContain("weekly report for Aug 2 – Aug 8, 2026");
  });
});
