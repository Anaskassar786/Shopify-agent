/**
 * Embedded-host bootstrap (M3). The app is loaded by Shopify Admin inside an
 * iframe with App Bridge present; everywhere else (direct URL, previews) it
 * must FAIL SAFE into the install gate — never crash, never fake a session.
 */

/** How long the App Bridge handshake may take before we treat it as absent. */
const ID_TOKEN_TIMEOUT_MS = 4_000;

export interface EmbeddedHostState {
  readonly embedded: boolean;
  /** myshopify domain from the URL when present (install gate deep link). */
  readonly shop: string | null;
}

export function detectEmbeddedHost(search: string): EmbeddedHostState {
  const shopParam = new URLSearchParams(search).get("shop");
  return {
    embedded: typeof window !== "undefined" && window.shopify !== undefined,
    shop: shopParam !== null && shopParam !== "" ? shopParam : null,
  };
}

/**
 * Shopify session token (JWT signed by Shopify, ~60s TTL) for the backend's
 * /auth/session exchange. Returns null when App Bridge is absent or the
 * handshake stalls — callers fall back to the install gate / stored refresh.
 */
export async function getShopifySessionToken(
  timeoutMs: number = ID_TOKEN_TIMEOUT_MS,
): Promise<string | null> {
  if (typeof window === "undefined" || window.shopify === undefined) return null;
  try {
    return await Promise.race([
      window.shopify.idToken(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  }
}

/** Decode a JWT payload without verification (client-side display only — the server verifies). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payloadPart = parts[1];
    if (payloadPart === undefined) return null;
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(normalized);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface JwtAppClaims {
  readonly userId: string;
  readonly storeId: string;
  readonly role: string;
  readonly permissions: readonly string[];
}

export function claimsFromAccessToken(token: string): JwtAppClaims | null {
  const payload = decodeJwtPayload(token);
  if (payload === null) return null;
  const { sub, storeId, role, perms } = payload as {
    sub?: unknown;
    storeId?: unknown;
    role?: unknown;
    perms?: unknown;
  };
  if (
    typeof sub !== "string" ||
    typeof storeId !== "string" ||
    typeof role !== "string" ||
    !Array.isArray(perms)
  ) {
    return null;
  }
  return {
    userId: sub,
    storeId,
    role,
    permissions: perms.filter((p): p is string => typeof p === "string"),
  };
}
