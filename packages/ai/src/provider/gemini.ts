import { createHash } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ModelTier } from "@profit/types";
import { AiProviderId } from "@profit/types";
import {
  AiProviderError,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
} from "./port";

/**
 * Gemini adapter (P10 primary provider) over the raw generateContent HTTP
 * API — no SDK: the contract is small, version-pinned, and fully owned here.
 *
 * Guardrails (P10): structured output is ENFORCED twice — server-side by
 * `responseSchema` (the model is physically constrained to the JSON Schema
 * derived from the caller's Zod contract) and client-side by the Zod parse.
 * One deterministic repair attempt runs on malformed output; a second
 * failure is typed INVALID_OUTPUT and never reaches business logic.
 *
 * Retries: RATE_LIMITED / transient 5xx are retried with bounded exponential
 * backoff; everything else fails typed immediately.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** USD micros (1e-6 $) per 1 MILLION tokens — conservative public-pricing estimates. */
interface ModelPricing {
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
}

const PRICING: Readonly<Record<string, ModelPricing>> = {
  // gemini-2.0-flash: $0.10 / $0.40 per 1M tokens.
  "gemini-2.0-flash": { inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 400_000 },
  // gemini-2.5-flash: $0.30 / $2.50 per 1M tokens (text).
  "gemini-2.5-flash": { inputMicrosPerMillion: 300_000, outputMicrosPerMillion: 2_500_000 },
  // gemini-2.5-pro (<=200k ctx): $1.25 / $10.00 per 1M tokens.
  "gemini-2.5-pro": { inputMicrosPerMillion: 1_250_000, outputMicrosPerMillion: 10_000_000 },
};

/** Unknown models bill at the HIGHEST known rate — cost estimates never under-report. */
const FALLBACK_PRICING: ModelPricing = {
  inputMicrosPerMillion: 1_250_000,
  outputMicrosPerMillion: 10_000_000,
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface GeminiProviderOptions {
  readonly apiKey: string;
  /** Tier → model mapping; every tier resolves through modelFor(). */
  readonly models: { readonly [K in ModelTier]: string };
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Network seam for tests — defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

interface GenerateContentResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
    readonly finishReason?: string;
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
  readonly error?: { readonly code?: number; readonly message?: string; readonly status?: string };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class GeminiProvider implements AiProvider {
  readonly id = AiProviderId.Gemini;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GeminiProviderOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? defaultSleep;
  }

  modelFor(tier: ModelTier): string {
    return this.options.models[tier];
  }

  async generate<TOutput>(
    request: AiGenerateRequest<TOutput>,
  ): Promise<AiGenerateResult<TOutput>> {
    const model = this.modelFor(request.modelTier);
    let lastInvalid: AiProviderError | undefined;
    // Attempt 1 (normal) + attempt 2 (repair instruction) — the ONLY repair
    // loop permitted; a second failure is typed and propagates.
    for (let repair = 0; repair <= 1; repair += 1) {
      const body = buildRequestBody(request, repair === 1);
      const startedAt = Date.now();
      const parsed = parseApiResponse(await this.callWithRetry(model, body));
      const latencyMs = Date.now() - startedAt;
      if (parsed.error !== undefined) {
        throw new AiProviderError(
          "PROVIDER_ERROR",
          `gemini returned in-body error: ${parsed.error.message ?? "unknown"}`,
          false,
        );
      }
      const text = extractCandidateText(parsed);
      try {
        const output = parseStructuredOutput(request, text);
        const pricing = PRICING[model] ?? FALLBACK_PRICING;
        const inputTokens = parsed.usageMetadata?.promptTokenCount ?? 0;
        const outputTokens = parsed.usageMetadata?.candidatesTokenCount ?? 0;
        return {
          output,
          rawJson: text,
          model,
          usage: {
            inputTokens,
            outputTokens,
            latencyMs,
            costMicros:
              Math.ceil((inputTokens * pricing.inputMicrosPerMillion) / 1_000_000) +
              Math.ceil((outputTokens * pricing.outputMicrosPerMillion) / 1_000_000),
          },
        };
      } catch (error) {
        if (error instanceof AiProviderError && error.kind === "INVALID_OUTPUT" && repair === 0) {
          lastInvalid = error;
          continue; // one deterministic repair pass
        }
        throw error;
      }
    }
    throw lastInvalid ?? new AiProviderError("INVALID_OUTPUT", "gemini repair loop exhausted", false);
  }

  private async callWithRetry(model: string, body: Record<string, unknown>): Promise<string> {
    let lastError: AiProviderError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
      }
      try {
        return await this.callOnce(model, body);
      } catch (error) {
        const typed = error instanceof AiProviderError ? error : new AiProviderError(
          "PROVIDER_ERROR",
          error instanceof Error ? error.message : "unknown gemini transport error",
          false,
        );
        lastError = typed;
        if (!typed.retryable || attempt === this.maxRetries) throw typed;
      }
    }
    // Unreachable (loop either returns or throws) — keeps TS honest.
    throw lastError ?? new AiProviderError("PROVIDER_ERROR", "gemini retry loop exhausted", false);
  }

  private async callOnce(model: string, body: Record<string, unknown>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const payload = await response.text();
      if (RETRYABLE_STATUS.has(response.status)) {
        throw new AiProviderError(
          response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
          `gemini http ${response.status}: ${payload.slice(0, 300)}`,
          true,
        );
      }
      if (!response.ok) {
        throw new AiProviderError(
          "PROVIDER_ERROR",
          `gemini http ${response.status}: ${payload.slice(0, 300)}`,
          false,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AiProviderError("TIMEOUT", `gemini call exceeded ${this.timeoutMs}ms`, true);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** One repair instruction appended when the first response fails validation. */
const REPAIR_SUFFIX =
  "\n\nCRITICAL: Your previous response was not valid for the required JSON schema. " +
  "Respond with ONLY a JSON object that exactly matches the schema. No prose, no markdown fences.";

export function buildRequestBody<TOutput>(
  request: AiGenerateRequest<TOutput>,
  repair = false,
): Record<string, unknown> {
  const system = request.messages.find((m) => m.role === "system");
  const users = request.messages.filter((m) => m.role === "user");
  const jsonSchema = zodToJsonSchema(request.outputSchema, { $refStrategy: "none" });
  return {
    ...(system !== undefined
      ? { systemInstruction: { parts: [{ text: system.content }] } }
      : {}),
    contents: users.map((message, index) => ({
      role: "user",
      parts: [
        {
          text:
            repair && index === users.length - 1
              ? `${message.content}${REPAIR_SUFFIX}`
              : message.content,
        },
      ],
    })),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
    },
  };
}

function parseApiResponse(raw: string): GenerateContentResponse {
  try {
    return JSON.parse(raw) as GenerateContentResponse;
  } catch {
    throw new AiProviderError("PROVIDER_ERROR", "gemini returned non-JSON transport body", false);
  }
}

function extractCandidateText(response: GenerateContentResponse): string {
  const candidate = response.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (text === undefined || text === "") {
    throw new AiProviderError(
      "INVALID_OUTPUT",
      `gemini produced no content (finishReason=${candidate?.finishReason ?? "none"})`,
      false,
    );
  }
  return text;
}

function parseStructuredOutput<TOutput>(
  request: AiGenerateRequest<TOutput>,
  text: string,
): TOutput {
  let parsedJson: unknown;
  try {
    // Tolerate accidental markdown fences; the schema remains the authority.
    parsedJson = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new AiProviderError(
      "INVALID_OUTPUT",
      `gemini output for ${request.promptId}@${request.promptVersion} was not parseable JSON`,
      false,
    );
  }
  const validated = request.outputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AiProviderError(
      "INVALID_OUTPUT",
      `gemini output for ${request.promptId}@${request.promptVersion} failed schema validation: ${
        validated.error.issues[0]?.message ?? "unknown issue"
      }`,
      false,
    );
  }
  return validated.data;
}

export { digestOf as sha256 };
