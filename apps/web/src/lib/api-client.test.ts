import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, buildQuery } from "./api-client";

function envelopeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function success(data: unknown, meta: unknown = null): unknown {
  return {
    success: true,
    data,
    errors: null,
    message: "ok",
    meta,
    timestamp: "2026-08-05T00:00:00.000Z",
    requestId: "req-123",
  };
}

function failure(status: number, code: string, message: string): { body: unknown; status: number } {
  return {
    status,
    body: {
      success: false,
      data: null,
      errors: [{ code, message, field: "title", details: { min: 2 } }],
      message,
      meta: null,
      timestamp: "2026-08-05T00:00:00.000Z",
      requestId: "req-err",
    },
  };
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}): ApiClient {
  return new ApiClient({
    getAccessToken: () => "token-1",
    refreshAccessToken: () => Promise.resolve("token-2"),
    fetchImpl,
    ...overrides,
  });
}

describe("buildQuery", () => {
  it("skips undefined and empty strings, encodes values", () => {
    expect(buildQuery({ page: 2, q: "alfa runner", skip: undefined, empty: "", flag: true })).toBe(
      "?page=2&q=alfa%20runner&flag=true",
    );
    expect(buildQuery({})).toBe("");
  });
});

describe("ApiClient", () => {
  it("unwraps the success envelope and attaches the bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(envelopeResponse(success({ hello: "world" }))));
    const client = makeClient(fetchMock);
    await expect(client.get<{ hello: string }>("/api/v1/store")).resolves.toEqual({ hello: "world" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-1");
  });

  it("getWithMeta preserves pagination + extras", async () => {
    const meta = { pagination: { page: 1, pageSize: 25, totalItems: 42, totalPages: 2 }, extras: { unread: 7 } };
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(envelopeResponse(success([1, 2], meta))));
    const client = makeClient(fetchMock);
    const result = await client.getWithMeta<readonly number[]>("/api/v1/notifications", { page: 1 });
    expect(result.data).toEqual([1, 2]);
    expect(result.meta?.pagination?.totalItems).toBe(42);
    expect(result.meta?.extras?.["unread"]).toBe(7);
  });

  it("throws a typed ApiError with server code/request id on error envelopes", async () => {
    const { status, body } = failure(422, "VALIDATION_FAILED", "title is required");
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(envelopeResponse(body, status)));
    const client = makeClient(fetchMock);
    const error = await client.get("/api/v1/products").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("VALIDATION_FAILED");
    expect(apiError.requestId).toBe("req-err");
    expect(apiError.field).toBe("title");
  });

  it("on 401 refreshes once and retries with the new token", async () => {
    const responses = [
      envelopeResponse(failure(401, "AUTH_EXPIRED", "expired").body, 401),
      envelopeResponse(success({ ok: true })),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift() ?? envelopeResponse(success(null))));
    const refresh = vi.fn(() => Promise.resolve("token-fresh"));
    const client = makeClient(fetchMock, { refreshAccessToken: refresh });
    await expect(client.get<{ ok: boolean }>("/api/v1/store")).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((secondInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-fresh");
  });

  it("dedupes concurrent 401 refreshes into a single refresh call", async () => {
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>(() => {
      call += 1;
      return Promise.resolve(
        call <= 2
          ? envelopeResponse(failure(401, "AUTH_EXPIRED", "expired").body, 401)
          : envelopeResponse(success({ ok: true })),
      );
    });
    const refresh = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "token-fresh";
    });
    const client = makeClient(fetchMock, { refreshAccessToken: refresh });
    const [a, b] = await Promise.all([client.get("/api/v1/a"), client.get("/api/v1/b")]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces refresh failure as the original 401 error", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(envelopeResponse(failure(401, "AUTH_EXPIRED", "expired").body, 401)),
    );
    const client = makeClient(fetchMock, { refreshAccessToken: () => Promise.resolve(null) });
    const error = await client.get("/api/v1/store").catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(401);
  });

  it("maps fetch rejections to NETWORK_ERROR with status 0 (offline detection)", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch")));
    const client = makeClient(fetchMock);
    const error = await client.get("/api/v1/store").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).code).toBe("NETWORK_ERROR");
  });

  it("maps non-envelope responses to UNEXPECTED_RESPONSE", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(envelopeResponse("<html>bad gateway</html>", 502)));
    const client = makeClient(fetchMock);
    const error = await client.get("/api/v1/store").catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("UNEXPECTED_RESPONSE");
    expect((error as ApiError).status).toBe(502);
  });

  it("postPublic never attaches the access token", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(envelopeResponse(success({ ok: true }))));
    const client = makeClient(fetchMock);
    await client.postPublic("/api/v1/auth/session", { sessionToken: "x" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(init.body).toBe(JSON.stringify({ sessionToken: "x" }));
  });
});
