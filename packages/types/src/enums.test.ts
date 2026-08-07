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
      "CHECKOUTS", // M4: abandoned-checkout recovery feed (8th module)
    ]);
    expect(Object.values(enums.ShopifyWebhookTopic)).toContain("app/uninstalled");
    expect(Object.values(enums.ShopifyWebhookTopic)).toContain("customers/data_request");
    expect(Object.values(enums.ShopifyWebhookTopic)).toContain("customers/redact");
    expect(Object.values(enums.ShopifyWebhookTopic)).toContain("shop/redact");
    expect(Object.values(enums.QueueName)).toContain("sync");
    expect(Object.values(enums.QueueName)).toContain("analytics");
  });

  it("M5 billing/growth enums carry exactly the documented values", () => {
    expect(Object.values(enums.SubscriptionStatus)).toContain("CHARGE_PENDING");
    expect(Object.values(enums.BillingInterval)).toEqual(["MONTHLY", "YEARLY"]);
    expect(Object.values(enums.UsageMeter)).toEqual([
      "AI_CALLS",
      "EMAILS_SENT",
      "SMS_SENT",
      "AUTOMATION_RUNS",
    ]);
    // Milestone kinds must mirror the engagement_events_milestone_unique
    // partial-index predicate in packages/db schema (literal there for snapshot
    // determinism) — this assertion is the compile-time sync check.
    expect(enums.ENGAGEMENT_MILESTONE_KINDS).toEqual([
      "STORE_CONNECTED",
      "FIRST_SYNC_COMPLETED",
      "FIRST_AI_RUN_COMPLETED",
      "FIRST_AI_INSIGHT_VIEWED",
      "FIRST_RECOMMENDATION_APPROVED",
      "FIRST_AUTOMATION_ENABLED",
      "PAID_SUBSCRIPTION_STARTED",
      "FIRST_WORKFLOW_ACTIVATED",
      "FIRST_CAMPAIGN_SENT",
    ]);
    for (const kind of enums.ENGAGEMENT_MILESTONE_KINDS) {
      expect(Object.values(enums.EngagementEventKind), `${kind} must be an engagement kind`).toContain(kind);
    }
  });
});
