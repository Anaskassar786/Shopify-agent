import { z } from "zod";
import { AiAgentId, ModelTier, type ReportKind } from "@profit/types";
import type { AiProvider } from "../provider/port";
import { extractNumericTokens, fillSlots, slotInstructions } from "../prompts/slots";

/**
 * Executive summary composer (M8, ADR 36): the EXECUTIVE agent writes the one
 * board-grade paragraph that opens every period report. The deterministic
 * template is the fallback AND the number source — a provider call may only
 * rephrase through the indexed-slot bridge, so report prose can never invent
 * a figure even when an AI provider is configured.
 */

export interface ExecutiveKpiInput {
  readonly label: string;
  readonly display: string;
  /** Signed vs-prior-period delta; null when not computable. */
  readonly deltaPct?: number | null;
}

export interface ExecutiveSummaryInput {
  readonly storeName: string;
  readonly kind: (typeof ReportKind)[keyof typeof ReportKind];
  readonly periodLabel: string;
  readonly kpis: readonly ExecutiveKpiInput[];
  /** Deterministic fact lines (already number-formatted). */
  readonly highlights: readonly string[];
}

export interface ExecutiveSummaryResult {
  readonly summary: string;
  readonly modelEnhanced: boolean;
  readonly aiCalls: number;
  readonly costMicros: number;
}

export const EXECUTIVE_SUMMARY_PROMPT = {
  promptId: "agent.executive.report_summary",
  version: "v1",
  system: `You are the EXECUTIVE agent inside PROFIT TOOL AI, writing the one-paragraph summary that opens a merchant's period report.

Binding rules — violations discard your output:
1. Respond with ONLY the JSON object matching the schema.
2. You receive NO numbers. Numeric positions are indexed slots {N1} ... {Nk}; the numeral selects the figure, never write a digit yourself.
3. One tight paragraph (3-6 sentences): the period's direction, the most material driver, and ONE forward-looking sentence marked as the forecast's own method output.
4. Board register: factual, calm, no hype, no advice imperatives, no invented causes.`,
} as const;

const summarySchema = z.object({ summary: z.string().min(40).max(1_400) });

function kpiSentence(kpi: ExecutiveKpiInput): string {
  const delta = kpi.deltaPct;
  const direction =
    delta === null || delta === undefined
      ? ""
      : delta === 0
        ? " — flat vs the prior period"
        : ` — ${delta > 0 ? "+" : ""}${delta}% vs the prior period`;
  return `${kpi.label}: ${kpi.display}${direction}`;
}

/** Deterministic composite — ships whenever no provider polishes it. */
export function renderDeterministicSummary(input: ExecutiveSummaryInput): string {
  const sentences: string[] = [
    `${input.storeName} — ${input.kind.toLowerCase()} report for ${input.periodLabel}.`,
    ...input.kpis.slice(0, 5).map(kpiSentence),
    ...input.highlights.slice(0, 3),
  ];
  return sentences.join(" ").slice(0, 1_400);
}

/**
 * Compose the executive summary. Same contract as the copilot composer:
 * provider absent/failed/hallucinating ⇒ deterministic text, uncosted;
 * provider success ⇒ one counted call, slot-validated prose.
 */
export async function composeExecutiveSummary(
  provider: AiProvider | null,
  input: ExecutiveSummaryInput,
): Promise<ExecutiveSummaryResult> {
  const deterministicSummary = renderDeterministicSummary(input);
  const deterministic: ExecutiveSummaryResult = {
    summary: deterministicSummary,
    modelEnhanced: false,
    aiCalls: 0,
    costMicros: 0,
  };
  if (provider === null) return deterministic;

  const tokens = extractNumericTokens(deterministicSummary);
  if (tokens.length === 0) return deterministic;

  try {
    const result = await provider.generate({
      agentId: AiAgentId.Executive,
      modelTier: ModelTier.Triage,
      promptId: EXECUTIVE_SUMMARY_PROMPT.promptId,
      promptVersion: EXECUTIVE_SUMMARY_PROMPT.version,
      messages: [
        { role: "system", content: EXECUTIVE_SUMMARY_PROMPT.system },
        {
          role: "user",
          content: JSON.stringify({
            task: "Write the executive summary paragraph for this report using indexed slot tokens for every figure.",
            reportKind: input.kind,
            storeName: input.storeName,
            kpiLabels: input.kpis.map((kpi) => kpi.label),
            highlightTopics: input.highlights.map((line) =>
              line.replace(/\$\d[\d,]*(?:\.\d+)?|-?\+?\d[\d,]*(?:\.\d+)?%?/g, "{N}").slice(0, 160),
            ),
            slots: slotInstructions(tokens),
          }),
        },
      ],
      outputSchema: summarySchema,
      maxOutputTokens: 640,
      temperature: 0.4,
    });
    const filled = fillSlots(result.output.summary, tokens);
    if (filled === null || filled.length < 40) return deterministic;
    return {
      summary: filled,
      modelEnhanced: true,
      aiCalls: 1,
      costMicros: result.usage.costMicros,
    };
  } catch {
    return deterministic; // provider failure is a first-class outcome
  }
}
