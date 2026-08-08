import { describe, expect, it } from "vitest";
import { CopilotIntent } from "@profit/types";
import { classifyIntent } from "./intents";

/** Closed-grammar router: every canonical phrasing lands on its intent. */
describe("copilot intent classifier (ADR 32 deterministic routing)", () => {
  it.each([
    ["Why are my sales down this week?", CopilotIntent.SalesWhyDown],
    ["why did revenue drop yesterday", CopilotIntent.SalesWhyDown],
    ["orders fell off a cliff — what's going on?", CopilotIntent.SalesWhyDown],
    ["Forecast next week's revenue", CopilotIntent.RevenueForecast],
    ["what do you predict our sales will be next month", CopilotIntent.RevenueForecast],
    ["projected revenue for the coming month?", CopilotIntent.RevenueForecast],
    ["What should I restock?", CopilotIntent.RestockWhat],
    ["are we running low on anything?", CopilotIntent.RestockWhat],
    ["which products are out of stock soon", CopilotIntent.RestockWhat],
    ["show me inventory risk", CopilotIntent.RestockWhat],
    ["which customers am I losing?", CopilotIntent.ChurnRisks],
    ["who is about to churn", CopilotIntent.ChurnRisks],
    ["give me the win-back candidates", CopilotIntent.ChurnRisks],
    ["Who are my VIP customers?", CopilotIntent.VipCustomers],
    ["show my best customers", CopilotIntent.VipCustomers],
    ["which products are dying?", CopilotIntent.ProductsDying],
    ["which items aren't selling anymore", CopilotIntent.ProductsDying],
    ["show me dead stock", CopilotIntent.ProductsDying],
    ["Should I run a discount?", CopilotIntent.DiscountSuggestion],
    ["any promo ideas for this weekend?", CopilotIntent.DiscountSuggestion],
    ["Give me a summary of the business", CopilotIntent.BusinessSummary],
    ["how is my store doing?", CopilotIntent.BusinessSummary],
    ["brief me on everything", CopilotIntent.BusinessSummary],
    ["How much revenue did we make this month?", CopilotIntent.RevenueSummary],
    ["total sales in the last 30 days?", CopilotIntent.RevenueSummary],
    ["hello there", CopilotIntent.GeneralOther],
    ["can you write me a poem?", CopilotIntent.GeneralOther],
    ["", CopilotIntent.GeneralOther],
  ] satisfies [string, CopilotIntent][])("classifies %j → %s", (question, intent) => {
    expect(classifyIntent(question).intent).toBe(intent);
  });

  it("specific intents win over their supersets (grammar order is the disambiguator)", () => {
    // "sales down" mentions revenue — decline must win over RevenueSummary.
    expect(classifyIntent("why is revenue down?").intent).toBe(CopilotIntent.SalesWhyDown);
    // "forecast revenue" mentions revenue — forecast must win.
    expect(classifyIntent("forecast my revenue please").intent).toBe(CopilotIntent.RevenueForecast);
    // "VIP" inside a churn-ish sentence stays churn.
    expect(classifyIntent("which loyal customers are going quiet?").intent).toBe(CopilotIntent.ChurnRisks);
  });

  it("exposes the matched grammar row for auditability", () => {
    const classified = classifyIntent("what should I restock first?");
    expect(classified.matchedPattern).toBe("replenishment-need");
    expect(classifyIntent("xyzzy").matchedPattern).toBeNull();
  });
});
