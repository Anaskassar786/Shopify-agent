import { createSecretKey } from "node:crypto";
import { decodeJwt, jwtVerify } from "jose";
import { AuthenticationError, ValidationError } from "../errors";
import { shopDomainFromIss, sanitizeShopDomain } from "./shop-domain";

/**
 * Shopify embedded-app session token verification (P2: Session Tokens; App
 * Bridge delivers these as Authorization: Bearer <jwt>). Algorithm:
 *   1. decode (unverified) to learn the shop from `iss`;
 *   2. validate shop shape, iss/dest agreement, nbf/exp sanity;
 *   3. verify HS256 signature with the app secret, audience = api key,
 *      issuer pinned to the decoded shop.
 * Fails closed on every anomaly (P5 security lists).
 */

export interface ShopifySessionClaims {
  readonly shopDomain: string;
  readonly shopifyUserId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
}

interface RawClaims {
  iss?: string;
  dest?: string;
  aud?: string;
  sub?: string;
  sid?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
}

export async function verifyShopifySessionToken(
  token: string,
  config: { apiKey: string; apiSecret: string },
): Promise<ShopifySessionClaims> {
  let raw: RawClaims;
  try {
    raw = decodeJwt(token) as RawClaims;
  } catch {
    throw new AuthenticationError("malformed session token");
  }

  if (raw.iss === undefined || raw.dest === undefined || raw.sub === undefined) {
    throw new AuthenticationError("session token missing required claims");
  }
  if (raw.sid === undefined || raw.exp === undefined || raw.iat === undefined) {
    throw new AuthenticationError("session token missing required claims");
  }

  let shopDomain: string;
  try {
    shopDomain = shopDomainFromIss(raw.iss);
    // dest must point at the same shop (token targeted at another store = reject).
    if (shopDomainFromIss(raw.dest) !== shopDomain) {
      throw new AuthenticationError("session token iss/dest mismatch");
    }
    sanitizeShopDomain(shopDomain);
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("session token carries an invalid shop");
  }

  const secret = createSecretKey(Buffer.from(config.apiSecret, "utf8"));
  try {
    await jwtVerify(token, secret, {
      audience: config.apiKey,
      issuer: raw.iss,
      algorithms: ["HS256"],
    });
  } catch {
    throw new AuthenticationError("session token signature verification failed");
  }

  return {
    shopDomain,
    shopifyUserId: raw.sub,
    sessionId: raw.sid,
    expiresAt: new Date(raw.exp * 1000),
    issuedAt: new Date(raw.iat * 1000),
  };
}

export function extractBearerToken(header: string | undefined): string {
  if (header === undefined) throw new AuthenticationError("authorization header missing");
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token === "") {
    throw new AuthenticationError("authorization header must be a Bearer token");
  }
  if (token.length > 8192) throw new ValidationError("authorization token too large");
  return token;
}
