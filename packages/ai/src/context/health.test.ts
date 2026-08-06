import { describe, expect, it } from "vitest";
import { computeStoreHealth } from "./health";
import { makeContext } from "../test-support/fixtures";

/** Store health contract: deterministic 0-100 with explainable components. */

describe("computeStoreHealth", () => {
  it("is deterministic and bounded", () => {
    const ctx = makeContext();
    const first = computeStoreHealth(ctx);
    const second = computeStoreHealth(ctx);
    expect(first).toEqual(second);
    expect(first.score).toBeGreaterThanOrEqual(0);
    expect(first.score).toBeLessThanOrEqual(100);
    expect(first.components).toHaveLength(6);
    for (const component of first.components) {
      expect(component.reason.length).toBeGreaterThan(0);
      expect(component.score).toBeGreaterThanOrEqual(0);
      expect(component.score).toBeLessThanOrEqual(100);
    }
  });

  it("growth helps, severe refunds hurt", () => {
    const healthy = computeStoreHealth(makeContext());
    const hurting = computeStoreHealth(
      makeContext({ refunds: { count: 12, cents: 90_000, ratePct: 20 } }),
    );
    expect(healthy.score).toBeGreaterThan(hurting.score);
  });

  it("every component weight sums to 100", () => {
    const total = computeStoreHealth(makeContext()).components.reduce(
      (sum, component) => sum + component.weight,
      0,
    );
    expect(total).toBe(100);
  });
});
