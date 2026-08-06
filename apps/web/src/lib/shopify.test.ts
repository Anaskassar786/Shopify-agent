import { describe, expect, it, vi } from "vitest";
import { claimsFromAccessToken, decodeJwtPayload, detectEmbeddedHost, getShopifySessionToken } from "./shopify";
import { makeJwt } from "../test-support/render";

describe("detectEmbeddedHost", () => {
  it("reports embedded=false outside App Bridge and reads the shop param", () => {
    const host = detectEmbeddedHost("?shop=moradabad-gems.myshopify.com&host=abc");
    expect(host.embedded).toBe(false);
    expect(host.shop).toBe("moradabad-gems.myshopify.com");
  });

  it("normalizes an empty shop param to null", () => {
    expect(detectEmbeddedHost("?shop=").shop).toBeNull();
    expect(detectEmbeddedHost("").shop).toBeNull();
  });

  it("reports embedded=true when window.shopify is present", () => {
    vi.stubGlobal("shopify", { idToken: () => Promise.resolve("tok") });
    // window.shopify assignment via stubGlobal on window object
    expect(detectEmbeddedHost("?shop=a.myshopify.com").embedded).toBe(true);
  });
});

describe("getShopifySessionToken", () => {
  it("returns the App Bridge id token", async () => {
    window.shopify = { idToken: () => Promise.resolve("shopify-session-token") } as never;
    await expect(getShopifySessionToken()).resolves.toBe("shopify-session-token");
  });

  it("returns null when App Bridge is absent", async () => {
    delete (window as { shopify?: unknown }).shopify;
    await expect(getShopifySessionToken()).resolves.toBeNull();
  });

  it("times out instead of hanging when the handshake stalls", async () => {
    window.shopify = { idToken: () => new Promise(() => undefined) } as never;
    const started = Date.now();
    const token = await getShopifySessionToken(25);
    expect(token).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("swallows idToken rejections into null", async () => {
    window.shopify = { idToken: () => Promise.reject(new Error("expired")) } as never;
    await expect(getShopifySessionToken()).resolves.toBeNull();
  });
});

describe("decodeJwtPayload / claimsFromAccessToken", () => {
  it("round-trips the claim layout the API issues", () => {
    const token = makeJwt({ sub: "user-9", storeId: "store-9", role: "MANAGER", perms: ["analytics:read"] });
    const claims = claimsFromAccessToken(token);
    expect(claims).toEqual({ userId: "user-9", storeId: "store-9", role: "MANAGER", permissions: ["analytics:read"] });
  });

  it("rejects malformed tokens", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
    expect(decodeJwtPayload("a.b.c")).toBeNull();
    expect(claimsFromAccessToken("")).toBeNull();
  });

  it("rejects payloads missing required claims", () => {
    const bad = `${btoa("{}")}.${btoa(JSON.stringify({ sub: "u" }))}.${btoa("s")}`;
    expect(claimsFromAccessToken(bad)).toBeNull();
  });

  it("filters non-string permissions defensively", () => {
    const payload = { sub: "u", storeId: "s", role: "OWNER", perms: ["a", 7, "b"] };
    const token = `${btoa("{}")}.${btoa(JSON.stringify(payload))}.${btoa("s")}`;
    expect(claimsFromAccessToken(token)?.permissions).toEqual(["a", "b"]);
  });
});
