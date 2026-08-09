import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiAgentId, ModelTier } from "@profit/types";
import { AiProviderError, type AiGenerateRequest } from "./port";
import { GeminiProvider, digestOf } from "./gemini";

/**
 * Gemini adapter contract — the ONLY stubbed boundary is fetch itself
 * (network edge, same rule as the Shopify suites). Proves: structured output
 * enforcement, the one-shot repair pass, typed failure taxonomy, retry
 * policy, and conservative local cost metering.
 */

const outputSchema = z.object({
  drafts: z.array(z.object({ title: z.string().min(1), confidence: z.number().int() })).max(4),
});

function makeRequest(): AiGenerateRequest<z.infer<typeof outputSchema>> {
  return {
    agentId: AiAgentId.BusinessAnalyst,
    modelTier: ModelTier.Triage,
    promptId: "agent.business_analyst",
    promptVersion: "v1",
    messages: [
      { role: "system", content: "system rules" },
      { role: "user", content: "{\"task\":\"analyze\"}" },
    ],
    outputSchema,
    maxOutputTokens: 1_000,
    temperature: 0.3,
  };
}

function geminiOk(payload: unknown, usage?: { promptTokenCount?: number; candidatesTokenCount?: number }) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }],
      usageMetadata: usage ?? { promptTokenCount: 500, candidatesTokenCount: 100 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function providerWith(fetchImpl: typeof fetch): GeminiProvider {
  return new GeminiProvider({
    apiKey: "test-key",
    models: { TRIAGE: "gemini-2.0-flash", STANDARD: "gemini-2.5-flash", DEEP: "gemini-2.5-pro" },
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
  });
}

describe("GeminiProvider.generate", () => {
  it("parses schema-valid output and meters usage + cost", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiOk({ drafts: [{ title: "Win big", confidence: 88 }] }),
    ) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl);
    const result = await provider.generate(makeRequest());

    expect(result.output.drafts[0]?.title).toBe("Win big");
    expect(result.model).toBe("gemini-2.0-flash");
    expect(result.usage.inputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(100);
    // 500 * 0.1 micro/token ceil + 100 * 0.4 micro/token ceil = 50 + 40 = 90 micros.
    expect(result.usage.costMicros).toBe(90);

    const call = vi.mocked(fetchImpl).mock.calls[0];
    const body = JSON.parse(String(call?.[1]?.body)) as {
      systemInstruction?: { parts: { text: string }[] };
      generationConfig: { responseMimeType: string; responseSchema: { type?: string } };
    };
    expect(String(call?.[0])).toContain("gemini-2.0-flash:generateContent");
    expect(body.systemInstruction?.parts[0]?.text).toBe("system rules");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBeDefined();
  });

  it("repairs once after invalid output, then succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? geminiOkRaw("not json at all")
        : geminiOk({ drafts: [{ title: "Fixed", confidence: 70 }] });
    }) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl);
    const result = await provider.generate(makeRequest());
    expect(result.output.drafts[0]?.title).toBe("Fixed");
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(2);
    const repaired = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[1]?.[1]?.body)) as {
      contents: { parts: { text: string }[] }[];
    };
    expect(repaired.contents[0]?.parts[0]?.text).toContain("CRITICAL");
  });

  it("types INVALID_OUTPUT after the repair attempt also fails", async () => {
    const fetchImpl = vi.fn(async () => geminiOkRaw("{]")) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl);
    const failure = await provider.generate(makeRequest()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiProviderError);
    expect((failure as AiProviderError).kind).toBe("INVALID_OUTPUT");
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(2);
  });

  it("types schema violations as INVALID_OUTPUT (not a transport error)", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiOk({ drafts: [{ title: "", confidence: 700 }] }),
    ) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl);
    const failure = await provider.generate(makeRequest()).catch((e: unknown) => e);
    expect((failure as AiProviderError).kind).toBe("INVALID_OUTPUT");
  });

  it("retries 429 with backoff and eventually succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call < 3
        ? new Response("quota", { status: 429 })
        : geminiOk({ drafts: [{ title: "After retry", confidence: 60 }] });
    }) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl);
    const result = await provider.generate(makeRequest());
    expect(result.output.drafts[0]?.title).toBe("After retry");
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(3);
  });

  it("exhausted 429s surface typed RATE_LIMITED", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota", { status: 429 })) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl);
    const failure = await provider.generate(makeRequest()).catch((e: unknown) => e);
    expect((failure as AiProviderError).kind).toBe("RATE_LIMITED");
    expect((failure as AiProviderError).retryable).toBe(true);
  });

  it("non-retryable http failures type as PROVIDER_ERROR without retry", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl);
    const failure = await provider.generate(makeRequest()).catch((e: unknown) => e);
    expect((failure as AiProviderError).kind).toBe("PROVIDER_ERROR");
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(1);
  });

  it("abort maps to typed TIMEOUT", async () => {
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    ) as unknown as typeof fetch;
    const provider = new GeminiProvider({
      apiKey: "k",
      models: { TRIAGE: "m", STANDARD: "m", DEEP: "m" },
      fetchImpl,
      timeoutMs: 20,
      sleepImpl: () => Promise.resolve(),
    });
    const failure = await provider.generate(makeRequest()).catch((e: unknown) => e);
    expect((failure as AiProviderError).kind).toBe("TIMEOUT");
  });

  it("unknown models bill at the conservative fallback rate", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiOk({ drafts: [{ title: "x", confidence: 1 }] }, { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 }),
    ) as unknown as typeof fetch;
    const provider = new GeminiProvider({
      apiKey: "k",
      models: { TRIAGE: "unreleased-model-9", STANDARD: "m", DEEP: "m" },
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
    });
    const result = await provider.generate(makeRequest());
    // fallback: 1M in * 1_250_000/1M + 1M out * 10_000_000/1M = 11_250_000 micros.
    expect(result.usage.costMicros).toBe(11_250_000);
  });
});

function geminiOkRaw(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("digestOf", () => {
  it("produces stable sha256 digests", () => {
    expect(digestOf("abc")).toBe(digestOf("abc"));
    expect(digestOf("abc")).toHaveLength(64);
    expect(digestOf("abc")).not.toBe(digestOf("abd"));
  });
});
