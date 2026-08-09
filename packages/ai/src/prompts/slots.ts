/**
 * Slot passing (ADR 32/36): the engine's anti-hallucination bridge for any
 * provider-written prose (copilot leads, executive report summaries).
 *
 * Invariant: NUMBERS NEVER CROSS THE PROVIDER PORT. The model receives the
 * slot COUNT and writes indexed `{N1}…{Nk}` tokens; this engine validates
 * (no digit survives outside a slot, indices within budget) and substitutes
 * the deterministic tokens — display order or repetition is the model's
 * choice, the VALUES are never. A violated envelope is rejected silently and
 * the deterministic text ships instead.
 */

const SLOT_PATTERN = /\{N(\d+)\}/g;

/** Deterministic numeric tokens in display order (money, percents, counts). */
export function extractNumericTokens(text: string): readonly string[] {
  return text.match(/\$\d[\d,]*(?:\.\d+)?|-?\+?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
}

/**
 * Validate + fill an indexed-slot candidate. Returns null ⇒ caller falls
 * back to the deterministic text.
 */
export function fillSlots(candidate: string, tokens: readonly string[]): string | null {
  const indices: number[] = [];
  const stripped = candidate.replace(SLOT_PATTERN, (_match, indexText: string) => {
    indices.push(Number(indexText));
    return "";
  });
  // Any surviving digit, or any malformed placeholder, discards the draft.
  if (/\d/.test(stripped) || /[{}]/.test(stripped)) return null;
  if (indices.some((index) => index < 1 || index > tokens.length)) return null;
  const filled = candidate.replace(SLOT_PATTERN, (_match, indexText: string) => {
    return tokens[Number(indexText) - 1] ?? "";
  });
  return filled.trim().length >= 10 ? filled.trim() : null;
}

/** Provider-facing description of the slot grammar (kept once, reused). */
export function slotInstructions(tokens: readonly string[]): Record<string, unknown> {
  return {
    slotCount: tokens.length,
    grammar:
      "Numeric positions are written as indexed tokens {N1} ... {Nk}: the numeral selects WHICH deterministic figure appears (1-based, in the order listed to you). You may reorder or repeat tokens, but never write a digit yourself.",
  };
}
