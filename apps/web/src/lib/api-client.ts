import type { ApiErrorResponse, ApiMeta, ApiSuccessResponse } from "@profit/types";

/**
 * Envelope-aware API client (P2 contract). Every call unwraps the standard
 * envelope; every failure surfaces as a typed ApiError carrying the server's
 * error code + request id (rendered in ErrorState per P9). A single 401
 * triggers ONE in-flight refresh across the whole app (the auth layer
 * provides the refresh callback), then the original request retries once.
 */

export interface ApiErrorDetails {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly field: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly field: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(input: ApiErrorDetails) {
    super(input.message);
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.field = input.field;
    this.details = input.details;
  }
}

export interface ApiClientOptions {
  /** Base path the API is mounted at — same-origin by contract. */
  readonly baseUrl?: string;
  readonly getAccessToken: () => string | null;
  /** Called once on 401; resolves to the new access token or null. */
  readonly refreshAccessToken: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}

function isEnvelope(value: unknown): value is ApiSuccessResponse<unknown> | ApiErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    typeof (value as { success: unknown }).success === "boolean"
  );
}

/**
 * Result of a list call that needs the envelope meta (pagination, unread
 * counters, ...). The P2 envelope carries these OUTSIDE `data` — frozen M1/M2
 * contracts — so the client exposes them side-by-side instead of reshaping
 * the server response.
 */
export interface DataWithMeta<TData> {
  readonly data: TData;
  readonly meta: ApiMeta | null;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => string | null;
  private readonly refreshAccessToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl ?? "";
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get<TData>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<TData> {
    const query = params !== undefined ? buildQuery(params) : "";
    return this.request<TData>("GET", `${path}${query}`, undefined, true).then((r) => r.data);
  }

  /** GET that preserves envelope meta — the ONLY way to read pagination/extras. */
  getWithMeta<TData>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<DataWithMeta<TData>> {
    const query = params !== undefined ? buildQuery(params) : "";
    return this.request<TData>("GET", `${path}${query}`, undefined, true);
  }

  post<TData>(path: string, body?: unknown): Promise<TData> {
    return this.request<TData>("POST", path, body, true).then((r) => r.data);
  }

  patch<TData>(path: string, body?: unknown): Promise<TData> {
    return this.request<TData>("PATCH", path, body, true).then((r) => r.data);
  }

  /** Public endpoints (auth/session bootstrap) — no token attached. */
  postPublic<TData>(path: string, body?: unknown): Promise<TData> {
    return this.request<TData>("POST", path, body, false).then((r) => r.data);
  }

  private singleRefresh(): Promise<string | null> {
    this.refreshInFlight ??= this.refreshAccessToken().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async request<TData>(
    method: string,
    path: string,
    body: unknown,
    authenticated: boolean,
  ): Promise<DataWithMeta<TData>> {
    const attempt = async (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (authenticated && token !== null) headers["Authorization"] = `Bearer ${token}`;
      // exactOptionalPropertyTypes: never pass an explicitly-undefined body.
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      return this.fetchImpl(`${this.baseUrl}${path}`, init);
    };

    let response: Response;
    try {
      response = await attempt(this.getAccessToken());
    } catch {
      throw new ApiError({
        status: 0,
        code: "NETWORK_ERROR",
        message: "The server could not be reached. Check your connection and retry.",
        requestId: null,
        field: null,
        details: null,
      });
    }

    if (response.status === 401 && authenticated) {
      const refreshed = await this.singleRefresh();
      if (refreshed !== null) {
        try {
          response = await attempt(refreshed);
        } catch {
          throw new ApiError({
            status: 0,
            code: "NETWORK_ERROR",
            message: "The server could not be reached. Check your connection and retry.",
            requestId: null,
            field: null,
            details: null,
          });
        }
      }
    }

    const parsed: unknown = await response.json().catch(() => null);
    if (isEnvelope(parsed)) {
      if (parsed.success) {
        return { data: parsed.data as TData, meta: parsed.meta ?? null };
      }
      const first = parsed.errors[0];
      throw new ApiError({
        status: response.status,
        code: first?.code ?? "UNKNOWN_ERROR",
        message: first?.message ?? parsed.message,
        requestId: parsed.requestId ?? null,
        field: first?.field ?? null,
        details: first?.details ?? null,
      });
    }
    throw new ApiError({
      status: response.status,
      code: "UNEXPECTED_RESPONSE",
      message: `Unexpected server response (${String(response.status)}).`,
      requestId: null,
      field: null,
      details: null,
    });
  }
}

export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number | boolean] =>
      entry[1] !== undefined && entry[1] !== "",
  );
  if (entries.length === 0) return "";
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}`;
}
