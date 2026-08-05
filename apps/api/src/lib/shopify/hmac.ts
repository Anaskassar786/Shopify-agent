import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shopify HMAC verification (P2/P5 mandatory: webhook signature validation
 * and OAuth callback validation). Two distinct mechanisms:
 *
 * 1. Webhooks:   X-Shopify-Hmac-Sha256 = base64( HMAC-SHA256(secret, rawBody) )
 * 2. OAuth/PX:   hmac query param        = hex( HMAC-SHA256(secret, canonicalQuery) )
 *    where canonicalQuery is all params except hmac/signature, sorted, joined.
 *
 * Comparisons are timing-safe; malformed input fails closed.
 */

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyWebhookHmac(
  rawBody: Buffer,
  providedHmacHeader: string | undefined,
  apiSecret: string,
): boolean {
  if (providedHmacHeader === undefined || providedHmacHeader === "") return false;
  const calculated = createHmac("sha256", apiSecret).update(rawBody).digest("base64");
  return safeEqual(calculated, providedHmacHeader);
}

export interface QueryParams {
  readonly [key: string]: string | string[] | undefined;
}

/**
 * Builds the canonical query string per Shopify's OAuth signature spec:
 * drop hmac/signature, percent-escape only "%"→%25 and "&"→%26 in values,
 * sort pairs, join with "&" (express has already url-decoded values for us).
 */
export function canonicalizeQuery(params: QueryParams): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (key === "hmac" || key === "signature" || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const escaped = String(item).replace(/%/g, "%25").replace(/&/g, "%26");
      pairs.push(`${key}=${escaped}`);
    }
  }
  return pairs.sort().join("&");
}

export function verifyOauthQueryHmac(
  params: QueryParams,
  apiSecret: string,
): boolean {
  const provided = params["hmac"];
  if (typeof provided !== "string" || provided === "") return false;
  const digest = createHmac("sha256", apiSecret)
    .update(canonicalizeQuery(params))
    .digest("hex");
  return safeEqual(digest, provided);
}
