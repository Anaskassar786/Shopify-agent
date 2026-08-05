import { describe, expect, it } from "vitest";
import {
  InvalidShopDomainError,
  isShopDomain,
  sanitizeShopDomain,
  shopDomainFromIss,
} from "./shop-domain";

describe("sanitizeShopDomain", () => {
  it("accepts and normalizes valid myshopify domains", () => {
    expect(sanitizeShopDomain("  Demo-Store.myshopify.com ")).toBe("demo-store.myshopify.com");
    expect(sanitizeShopDomain("a1.myshopify.com")).toBe("a1.myshopify.com");
  });

  it("rejects anything else — custom domains, injections, empties", () => {
    for (const bad of [
      "example.com",
      "shop.myshopify.com.evil.com",
      "shop; DROP TABLE stores;--",
      "https://demo-store.myshopify.com",
      "UPPER SPACE.myshopify.com",
      "",
      "under_score.myshopify.com",
    ]) {
      expect(() => sanitizeShopDomain(bad), bad).toThrow(InvalidShopDomainError);
    }
  });

  it("isShopDomain is the non-throwing probe", () => {
    expect(isShopDomain("demo-store.myshopify.com")).toBe(true);
    expect(isShopDomain("evil.com")).toBe(false);
  });
});

describe("shopDomainFromIss (session-token iss/dest forms)", () => {
  it("parses the classic shop origin", () => {
    expect(shopDomainFromIss("https://demo-store.myshopify.com/admin")).toBe(
      "demo-store.myshopify.com",
    );
  });

  it("parses the new admin.shopify.com origin", () => {
    expect(shopDomainFromIss("https://admin.shopify.com/store/demo-store")).toBe(
      "demo-store.myshopify.com",
    );
  });

  it("parses bare host dest form", () => {
    expect(shopDomainFromIss("https://demo-store.myshopify.com")).toBe(
      "demo-store.myshopify.com",
    );
  });

  it("rejects malformed and non-shop issuers", () => {
    expect(() => shopDomainFromIss("not-a-url")).toThrow(InvalidShopDomainError);
    expect(() => shopDomainFromIss("https://evil.example.com/admin")).toThrow(
      InvalidShopDomainError,
    );
  });
});
