import { z } from "zod";
import { AiAgentId, ModelTier } from "@profit/types";
import type { AiProvider } from "../provider/port";
import { extractNumericTokens, fillSlots, slotInstructions } from "../prompts/slots";
import type { CopilotEvidence } from "./evidence";

/**
 * Copilot answer composer (ADR 32 — deterministic-first):
 *  - markdown is ALWAYS assembled by this module from the evidence bundle;
 *  - the optional provider path may only rephrase the LEAD through the
 *    indexed-slot bridge (prompts/slots.ts) — numbers never cross the
 *    provider port, a violated envelope falls back to the deterministic
 *    lead, and `aiCalls` counts real provider calls only.
 */

export interface CopilotAnswer {
  readonly text: string;
  readonly lead: string;
  readonly modelEnhanced: boolean;
  readonly aiCalls: number;
  readonly costMicros: number;
}

export const COPILOT_LEAD_PROMPT = {
  promptId: "copilot.lead_rephrase",
  version: "v1",
  system: `You polish ONE lead sentence for a merchant analytics copilot inside PROFIT TOOL AI.

Binding rules — violations discard your output:
1. Respond with ONLY the JSON object matching the schema.
2. You receive NO numbers. Numeric positions are indexed slots {N1} ... {Nk}; the numeral selects the figure, never write a digit yourself.
3. Keep the claim EXACTLY as scoped: same subject, direction (up/down/flat) and horizon. Add no causes, advice or promises.
4. ≤ 280 characters, warm and plain, no hype words.`,
} as const;

const leadSchema = z.object({ lead: z.string().min(10).max(280) });

/** Markdown envelope shared by every copilot answer (persisted verbatim). */
export function renderAnswer(evidence: CopilotEvidence, lead: string): string {
  const parts: string[] = [lead];
  if (evidence.bullets.length > 0) {
    parts.push("", ...evidence.bullets.map((bullet) => `- ${bullet}`));
  }
  for (const table of evidence.tables) {
    parts.push("", `**${table.title}**`, "");
    parts.push(`| ${table.columns.join(" | ")} |`);
    parts.push(`|${table.columns.map(() => " --- ").join("|")}|`);
    for (const row of table.rows) {
      parts.push(`| ${row.join(" | ")} |`);
    }
  }
  parts.push(
    "",
    `_Evidence window ${evidence.windowLabel} · method ${evidence.method} · confidence ${evidence.confidence}/100${
      evidence.recommendationRefs.length > 0
        ? ` · ${evidence.recommendationRefs.length} open action${evidence.recommendationRefs.length === 1 ? "" : "s"} linked`
        : ""
    }_`,
  );
  return parts.join("\n");
}

/**
 * Compose the final answer. Provider configured ⇒ ONE budgeted rephrase call
 * (counted); provider absent, failed or hallucinating ⇒ the deterministic
 * answer ships — identical numbers either way.
 */
export async function composeAnswer(
  provider: AiProvider | null,
  question: string,
  evidence: CopilotEvidence,
): Promise<CopilotAnswer> {
  const deterministic: CopilotAnswer = {
    text: renderAnswer(evidence, evidence.headline),
    lead: evidence.headline,
    modelEnhanced: false,
    aiCalls: 0,
    costMicros: 0,
  };
  if (provider === null) return deterministic;

  const tokens = extractNumericTokens(evidence.headline);
  if (tokens.length === 0) return deterministic; // no figures to protect — deterministic suffices

  try {
    const result = await provider.generate({
      agentId: AiAgentId.Executive,
      modelTier: ModelTier.Triage,
      promptId: COPILOT_LEAD_PROMPT.promptId,
      promptVersion: COPILOT_LEAD_PROMPT.version,
      messages: [
        { role: "system", content: COPILOT_LEAD_PROMPT.system },
        {
          role: "user",
          content: JSON.stringify({
            task: "Rewrite the copilot lead for this domain, keeping every numeric position an indexed slot token.",
            domain: evidence.intent,
            merchantQuestion: question.slice(0, 200),
            slots: slotInstructions(tokens),
          }),
        },
      ],
      outputSchema: leadSchema,
      maxOutputTokens: 256,
      temperature: 0.4,
    });
    const filled = fillSlots(result.output.lead, tokens);
    if (filled === null) return deterministic;
    return {
      text: renderAnswer(evidence, filled),
      lead: filled,
      modelEnhanced: true,
      aiCalls: 1,
      costMicros: result.usage.costMicros,
    };
  } catch {
    return deterministic; // provider failure is a first-class outcome (P3 failsafe)
  }
}
