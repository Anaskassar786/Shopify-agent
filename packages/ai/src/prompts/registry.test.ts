import { describe, expect, it } from "vitest";
import { AiAgentId } from "@profit/types";
import { AGENT_RUN_ORDER, agentOutputSchema, buildUserMessage, promptSpecFor } from "./registry";
import { evaluateRules } from "../rules/catalog";
import { makeContext } from "../test-support/fixtures";

/** Prompt registry contract (P10 prompt version control + bounded payloads). */

describe("prompt registry", () => {
  it("every agent has a versioned spec", () => {
    for (const agentId of Object.values(AiAgentId)) {
      const spec = promptSpecFor(agentId);
      expect(spec.promptId).toContain("agent.");
      expect(spec.version).toMatch(/^v\d+$/);
      expect(spec.systemPrompt).toContain("Respond with ONLY the JSON object");
      expect(spec.agentId).toBe(agentId);
    }
  });

  it("run order covers all decision agents exactly once (EXECUTIVE never runs firings)", () => {
    expect(new Set(AGENT_RUN_ORDER).size).toBe(AGENT_RUN_ORDER.length);
    const decisionAgents = Object.values(AiAgentId).filter((id) => id !== AiAgentId.Executive);
    expect([...AGENT_RUN_ORDER].sort()).toEqual(decisionAgents.sort());
    // EXECUTIVE phrases prose through the slot bridge only — deliberate exclusion.
    expect(AGENT_RUN_ORDER).not.toContain(AiAgentId.Executive);
    expect(AGENT_RUN_ORDER).toContain(AiAgentId.Pricing);
  });

  it("user message is JSON-bounded and carries firing refs", () => {
    const ctx = makeContext({
      checkouts: {
        abandonedCount: 1,
        abandonedValueCents: 9_600,
        abandoned: [{
          token: "token-9", customerId: null, firstName: "Mia", hasEmail: true, totalCents: 9_600,
          currency: "USD", itemCount: 1, itemsPreview: [{ title: "Shoe", quantity: 1 }],
          webUrl: "https://x", createdAt: "2026-08-05T00:00:00Z", hoursAgo: 9,
        }],
      },
    });
    const firings = evaluateRules(ctx);
    const message = buildUserMessage(AiAgentId.RevenueRecovery, firings, ctx);
    expect(message).toContain("token-9");
    expect(message.length).toBeLessThan(24_000);
    const parsed = JSON.parse(message) as { firings: unknown[]; context: unknown };
    expect(parsed.firings).toHaveLength(1);
    // PII discipline: the payload carries first names + aggregates, no emails.
    expect(message).not.toContain("@");
  });

  it("output schema enforces draft bounds", () => {
    expect(
      agentOutputSchema.safeParse({
        drafts: [{
          firingRef: "f1",
          title: "Solid title",
          description: "A sufficiently long description payload",
          reasoning: ["first concrete reason", "second concrete reason"],
          confidence: 50,
          priority: "LOW",
          risk: "LOW",
          emailDraft: null,
        }],
      }).success,
    ).toBe(true);
    expect(
      agentOutputSchema.safeParse({
        drafts: [{ firingRef: "", title: "x", description: "short", reasoning: [], confidence: 500, priority: "LOW", risk: "LOW", emailDraft: null }],
      }).success,
    ).toBe(false);
  });
});
