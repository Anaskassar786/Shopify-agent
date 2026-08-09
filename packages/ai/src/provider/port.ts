import type { AiAgentId, AiProviderId, ModelTier } from "@profit/types";
import type { z } from "zod";

/**
 * AI provider port (P3: "Never couple business logic with Gemini SDK").
 * Business code programs ONLY against this interface — Gemini today, OpenAI/
 * Claude/local tomorrow. Provider SDK types never escape this file's
 * implementations.
 *
 * Hard rules every adapter enforces:
 *  1. STRUCTURED OUTPUT ONLY (P10): the response is parsed by the caller's
 *     Zod schema before it exists as a value; free text never reaches
 *     business logic.
 *  2. USAGE IS METERED PER CALL (P10 cost control): token counts, latency
 *     and a locally-computed USD-micros estimate come back on every result.
 *  3. FAILURES ARE TYPED (P3 failsafe): adapters throw AiProviderError with
 *     a `kind` the decision service branches on — never raw SDK errors.
 */

export interface AiMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface AiGenerateRequest<TOutput> {
  /** Which agent is asking — drives per-agent logging + prompt registry lookups. */
  readonly agentId: AiAgentId;
  /** Cost tier (P10): TRIAGE for routine runs, STANDARD/DEEP for escalations. */
  readonly modelTier: ModelTier;
  /** Versioned prompt identity — stored on every call log + evidence snapshot. */
  readonly promptId: string;
  readonly promptVersion: string;
  readonly messages: readonly AiMessage[];
  /** The ONLY accepted response shape — adapter instructs the model with it. */
  readonly outputSchema: z.ZodType<TOutput>;
  /** Upper bound the adapter must respect for the completion. */
  readonly maxOutputTokens: number;
  /** Determinism dial — decision support uses low values. */
  readonly temperature: number;
}

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** USD micros (1e-6 USD), computed by the adapter's pricing table. */
  readonly costMicros: number;
  readonly latencyMs: number;
}

export interface AiGenerateResult<TOutput> {
  readonly output: TOutput;
  /** Canonical JSON of the output — digested into the call log. */
  readonly rawJson: string;
  readonly model: string;
  readonly usage: AiUsage;
}

export interface AiProvider {
  readonly id: AiProviderId;
  /** Model id used per tier — surfaced in call logs + evidence. */
  modelFor(tier: ModelTier): string;
  generate<TOutput>(request: AiGenerateRequest<TOutput>): Promise<AiGenerateResult<TOutput>>;
}

export type AiProviderErrorKind =
  | "UNAVAILABLE" // no credentials / provider disabled
  | "RATE_LIMITED"
  | "INVALID_OUTPUT" // model failed to produce schema-valid JSON (after repair pass)
  | "TIMEOUT"
  | "PROVIDER_ERROR";

export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind;
  readonly retryable: boolean;

  constructor(kind: AiProviderErrorKind, message: string, retryable: boolean) {
    super(message);
    this.name = "AiProviderError";
    this.kind = kind;
    this.retryable = retryable;
  }
}
