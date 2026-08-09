import { describe, expect, it } from "vitest";
import { formatDelta, halfSplitDelta } from "./series";

describe("halfSplitDelta", () => {
  it("compares second half against first half", () => {
    const delta = halfSplitDelta([10, 10, 20, 20]);
    expect(delta?.direction).toBe("up");
    expect(delta?.pct).toBeCloseTo(100);
  });

  it("flags declines", () => {
    const delta = halfSplitDelta([20, 20, 10, 10]);
    expect(delta?.direction).toBe("down");
    expect(delta?.pct).toBeCloseTo(-50);
  });

  it("returns null for zero baselines, flat series and short input", () => {
    expect(halfSplitDelta([0, 0, 5, 5])).toBeNull();
    expect(halfSplitDelta([5, 5, 5, 5])).toBeNull();
    expect(halfSplitDelta([7])).toBeNull();
    expect(halfSplitDelta([])).toBeNull();
  });
});

describe("formatDelta", () => {
  it("renders signed percents", () => {
    expect(formatDelta({ pct: 100, direction: "up" })).toBe("+100.0%");
    expect(formatDelta({ pct: -50, direction: "down" })).toBe("-50.0%");
    expect(formatDelta(null)).toBeNull();
  });
});
