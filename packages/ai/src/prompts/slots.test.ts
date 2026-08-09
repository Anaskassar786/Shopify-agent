import { describe, expect, it } from "vitest";
import { extractNumericTokens, fillSlots } from "./slots";

/** The anti-hallucination bridge: numbers never cross the provider port. */
describe("slot bridge (ADR 32/36)", () => {
  it("extracts money, percents and plain counts in display order", () => {
    expect(extractNumericTokens("Sales down 12% — net $1,204.50 across 3 orders."))
      .toEqual(["12%", "$1,204.50", "3"]);
    expect(extractNumericTokens("no figures here")).toEqual([]);
    expect(extractNumericTokens("trend +4% vs -9% prior")).toEqual(["+4%", "-9%"]);
  });

  it("fills indexed slots in the model's chosen order and allows repetition", () => {
    const tokens = ["$12,300.00", "8%", "42"];
    const filled = fillSlots("Revenue held near {N1}, up {N2} with {N3} orders — yes, {N1} again.", tokens);
    expect(filled).toBe("Revenue held near $12,300.00, up 8% with 42 orders — yes, $12,300.00 again.");
  });

  it("rejects any draft smuggling a digit outside the slots", () => {
    const tokens = ["$100.00"];
    expect(fillSlots("Revenue is {N1} but costs hit $999", tokens)).toBeNull();
    expect(fillSlots("Up 17% this week", tokens)).toBeNull();
    expect(fillSlots("Look {N1} at page 42", tokens)).toBeNull();
  });

  it("rejects malformed placeholders and out-of-budget indices", () => {
    const tokens = ["$100.00", "3"];
    expect(fillSlots("Revenue was {N1} across {N3} orders", tokens)).toBeNull(); // N3 > budget
    expect(fillSlots("Revenue was {N} dollars", tokens)).toBeNull(); // unindexed
    expect(fillSlots("Revenue was {N-1} weird", tokens)).toBeNull(); // malformed
    expect(fillSlots("Short", tokens)).toBeNull(); // below minimum length
  });
});
