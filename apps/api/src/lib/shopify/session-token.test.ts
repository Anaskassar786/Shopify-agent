import { createSecretKey } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { AuthenticationError } from "../errors";
import { extractBearerToken, verifyShopifySessionToken } from "./session-token";

const API_KEY = "test_api_key";
const API_SECRET = "test_api_secret";
const SHOP = "demo-store.myshopify.com";
const ISS = `https://${SHOP}/admin`;

interface ClaimOverrides {
  iss?: string;
  dest?: string;
  aud?: string;
  secret?: string;
  omitSub?: boolean;
}

async function makeToken(overrides: ClaimOverrides = {}): Promise<string> {
  const secret = createSecretKey(Buffer.from(overrides.secret ?? API_SECRET, "utf8"));
  let jwt = new SignJWT({
    dest: overrides.dest ?? `https://${SHOP}`,
    sid: "session-uuid-1",
    ...(overrides.omitSub === true ? {} : { sub: "shopify-user-1" }),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(overrides.iss ?? ISS)
    .setAudience(overrides.aud ?? API_KEY)
    .setIssuedAt()
    .setExpirationTime("60s");
  return jwt.sign(secret);
}

describe("verifyShopifySessionToken (P2: session token validation)", () => {
  it("verifies a well-formed token and extracts claims", async () => {
    const token = await makeToken();
    const claims = await verifyShopifySessionToken(token, {
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    expect(claims.shopDomain).toBe(SHOP);
    expect(claims.shopifyUserId).toBe("shopify-user-1");
    expect(claims.sessionId).toBe("session-uuid-1");
    expect(claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await makeToken({ secret: "wrong_secret" });
    await expect(
      verifyShopifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects an audience mismatch (token for another app)", async () => {
    const token = await makeToken({ aud: "other_app" });
    await expect(
      verifyShopifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects iss/dest disagreement (cross-store token)", async () => {
    const token = await makeToken({ dest: "https://other-store.myshopify.com" });
    await expect(
      verifyShopifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects malformed tokens and missing claims", async () => {
    await expect(
      verifyShopifySessionToken("not-a-jwt", { apiKey: API_KEY, apiSecret: API_SECRET }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const noSubject = await makeToken({ omitSub: true });
    await expect(
      verifyShopifySessionToken(noSubject, { apiKey: API_KEY, apiSecret: API_SECRET }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("extractBearerToken", () => {
  it("extracts a token", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("rejects missing/malformed headers", () => {
    expect(() => extractBearerToken(undefined)).toThrow(AuthenticationError);
    expect(() => extractBearerToken("Basic abc")).toThrow(AuthenticationError);
    expect(() => extractBearerToken("Bearer ")).toThrow(AuthenticationError);
  });
});
