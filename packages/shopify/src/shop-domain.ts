/**
 * Canonical validation for *.myshopify.com domains. Every entry point that
 * accepts a shop from the outside (install link, webhook headers, OAuth
 * callback) MUST pass through here before the domain touches a URL, a query,
 * or a log line (P5: input validation; open-redirect/injection prevention).
 */

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.myshopify\.com$/;

export class InvalidShopDomainError extends Error {
  constructor(input: string) {
    super(`invalid shop domain`);
    this.name = "InvalidShopDomainError";
    this.cause = { inputLength: input.length };
  }
}

export function sanitizeShopDomain(input: string): string {
  const normalized = input.trim().toLowerCase();
  if (!SHOP_DOMAIN_PATTERN.test(normalized)) {
    throw new InvalidShopDomainError(input);
  }
  return normalized;
}

export function isShopDomain(input: string): boolean {
  try {
    sanitizeShopDomain(input);
    return true;
  } catch {
    return false;
  }
}

/** Extract the shop domain from a Shopify session-token iss/dest URL. */
export function shopDomainFromIss(iss: string): string {
  let url: URL;
  try {
    url = new URL(iss);
  } catch {
    throw new InvalidShopDomainError(iss);
  }
  const host = url.hostname;
  if (host === "admin.shopify.com") {
    // New admin origin: iss = https://admin.shopify.com/store/{handle}
    const handle = url.pathname.split("/").filter(Boolean)[1];
    if (handle === undefined) throw new InvalidShopDomainError(iss);
    return sanitizeShopDomain(`${handle}.myshopify.com`);
  }
  return sanitizeShopDomain(host);
}
