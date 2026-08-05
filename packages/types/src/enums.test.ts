import { describe, expect, it } from "vitest";
import * as enums from "./domain/enums";

/**
 * Enum integrity contract (P1: no magic strings — these objects are the single
 * source of truth). Guards against accidental duplicate values, which would
 * silently break switch exhaustiveness and DB enum mappings downstream.
 */
describe("domain enums", () => {
  const enumObjects = Object.entries(enums).filter(
    ([, value]) => typeof value === "object" && value !== null,
  ) as Array<[string, Record<string, string>]>;

  it("exposes a non-trivial enum catalog", () => {
    expect(enumObjects.length).toBeGreaterThanOrEqual(10);
  });

  it("every enum has unique values (no aliases)", () => {
    for (const [name, obj] of enumObjects) {
      const values = Object.values(obj);
      expect(new Set(values).size, `duplicate value in ${name}`).toBe(values.length);
    }
  });

  it("every value is a non-empty string", () => {
    for (const [name, obj] of enumObjects) {
      for (const value of Object.values(obj)) {
        expect(typeof value, `${name} value must be string`).toBe("string");
        expect(value.length, `${name} value must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it("critical M2 enums carry exactly the documented values", () => {
    expect(Object.values(enums.SyncModule)).toEqual([
      "PRODUCTS",
      "CUSTOMERS",
      "ORDERS",
      "INVENTORY",
      "COLLECTIONS",
      "DISCOUNTS",
      "METAFIELDS",
    ]);
    expect(Object.values(enums.ShopifyWebhookTopic)).toContain("app/uninstalled");
    expect(Object.values(enums.ShopifyWebhookTopic)).toContain("customers/data_request");
    expect(Object.values(enums.ShopifyWebhookTopic)).toContain("customers/redact");
    expect(Object.values(enums.ShopifyWebhookTopic)).toContain("shop/redact");
    expect(Object.values(enums.QueueName)).toContain("sync");
    expect(Object.values(enums.QueueName)).toContain("analytics");
  });
});
