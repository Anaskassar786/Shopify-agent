import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeQuery, verifyOauthQueryHmac, verifyWebhookHmac } from "./hmac";

const SECRET = "shopify_test_secret";

describe("verifyWebhookHmac (P5: webhook signature validation)", () => {
  const body = Buffer.from(JSON.stringify({ id: 12345, name: "order" }), "utf8");

  function forgedHeader(payload: Buffer, secret: string): string {
    return createHmac("sha256", secret).update(payload).digest("base64");
  }

  it("accepts a correctly signed body", () => {
    expect(verifyWebhookHmac(body, forgedHeader(body, SECRET), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = forgedHeader(body, SECRET);
    const tampered = Buffer.concat([body, Buffer.from(" ")]);
    expect(verifyWebhookHmac(tampered, header, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verifyWebhookHmac(body, forgedHeader(body, "other"), SECRET)).toBe(false);
  });

  it("fails closed on missing header", () => {
    expect(verifyWebhookHmac(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookHmac(body, "", SECRET)).toBe(false);
  });
});

describe("OAuth query HMAC (P5: callback validation)", () => {
  const params = {
    code: "0907a61c0c8d55e99db179b68161bc00",
    shop: "some-shop.myshopify.com",
    state: "0.6784241404160823",
    timestamp: "1337178178",
  };

  function signAll(all: Record<string, string>, secret: string): string {
    return createHmac("sha256", secret).update(canonicalizeQuery(all)).digest("hex");
  }

  it("verifies a correctly signed callback", () => {
    const hmac = signAll(params, SECRET);
    expect(verifyOauthQueryHmac({ ...params, hmac }, SECRET)).toBe(true);
  });

  it("rejects a tampered parameter set", () => {
    const hmac = signAll(params, SECRET);
    expect(verifyOauthQueryHmac({ ...params, shop: "evil.myshopify.com", hmac }, SECRET)).toBe(false);
  });

  it("rejects when hmac is absent", () => {
    expect(verifyOauthQueryHmac(params, SECRET)).toBe(false);
  });

  it("canonicalization matches the Shopify spec (sorted, hmac/signature excluded)", () => {
    expect(
      canonicalizeQuery({ b: "2", a: "1", hmac: "x", signature: "y" }),
    ).toBe("a=1&b=2");
  });

  it("escapes % and & inside values per the Shopify spec", () => {
    expect(canonicalizeQuery({ a: "100%&go" })).toBe("a=100%25%26go");
  });
});
