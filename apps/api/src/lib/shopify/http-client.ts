/**
 * Minimal, hardened Shopify HTTP client (P5: network errors handled, timeouts
 * mandatory). Retries are confined to transport-level failures and explicit
 * 429/5xx responses with exponential backoff + jitter; 4xx responses fail
 * immediately because retrying cannot help them.
 */

export interface ShopifyHttpOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;

export class ShopifyHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "ShopifyHttpError";
    this.status = status;
    this.body = body;
  }
}

export class ShopifyNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ShopifyNetworkError";
    this.cause = cause;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, baseDelayMs: number): number {
  const jitter = Math.random() * baseDelayMs;
  return baseDelayMs * 2 ** attempt + jitter;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ShopifyNetworkError(`shopify request timed out after ${timeoutMs}ms`);
    }
    throw new ShopifyNetworkError("shopify request failed", error);
  } finally {
    clearTimeout(timer);
  }
}

export async function shopifyPostJson<TResponse>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: ShopifyHttpOptions = {},
): Promise<TResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };

  let lastNetworkError: ShopifyNetworkError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, timeoutMs);
    } catch (error) {
      if (error instanceof ShopifyNetworkError) {
        lastNetworkError = error;
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt, baseDelayMs));
          continue;
        }
      }
      throw error;
    }

    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text) as TResponse;
      } catch {
        throw new ShopifyHttpError(response.status, text, "shopify returned malformed JSON");
      }
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxRetries) {
        const retryAfter = response.headers.get("retry-after");
        const hint = retryAfter !== null ? Number(retryAfter) * 1000 : undefined;
        await sleep(hint !== undefined && Number.isFinite(hint) ? hint : backoffMs(attempt, baseDelayMs));
        continue;
      }
    }
    throw new ShopifyHttpError(
      response.status,
      text,
      `shopify responded with ${response.status}`,
    );
  }
  throw lastNetworkError ?? new ShopifyNetworkError("shopify request failed without response");
}

export async function shopifyGraphql<TData>(
  shopDomain: string,
  apiVersion: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  options: ShopifyHttpOptions = {},
): Promise<TData> {
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const result = await shopifyPostJson<{
    data?: TData;
    errors?: ReadonlyArray<{ message: string }>;
  }>(url, { query, variables }, { "X-Shopify-Access-Token": accessToken }, options);

  if (result.errors !== undefined && result.errors.length > 0) {
    throw new ShopifyHttpError(
      200,
      JSON.stringify(result.errors),
      `shopify graphql errors: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (result.data === undefined) {
    throw new ShopifyHttpError(200, "{}", "shopify graphql response contained no data");
  }
  return result.data;
}
