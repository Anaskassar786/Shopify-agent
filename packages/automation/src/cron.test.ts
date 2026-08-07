import { describe, expect, it } from "vitest";
import { nextOccurrence, parseCron } from "./cron";

/**
 * Cron contract: parse acceptance/rejection matrix + nextOccurrence exactness
 * (the scheduler's entire correctness budget lives here).
 */

describe("parseCron", () => {
  it("accepts the documented grammar", () => {
    expect(parseCron("* * * * *")).not.toBeNull();
    expect(parseCron("0 9 * * 1")).not.toBeNull();
    expect(parseCron("*/5 * * * *")).not.toBeNull();
    expect(parseCron("0 0 1 * *")).not.toBeNull();
    expect(parseCron("0 0 * * 0")).not.toBeNull();
    expect(parseCron("0 0 * * 7")).not.toBeNull(); // Sunday alias
    expect(parseCron("0 8-18/2 * * 1-5")).not.toBeNull();
    expect(parseCron("15,45 9,17 * * *")).not.toBeNull();
    expect(parseCron("0 9 1 1 *")).not.toBeNull();
  });

  it("normalizes day-of-week 7 to 0", () => {
    const schedule = parseCron("0 0 * * 7");
    expect(schedule?.dayOfWeek.values).toEqual([0]);
  });

  it("rejects malformed expressions", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * * *")).toBeNull();
    expect(parseCron("* * * * * *")).toBeNull();
    expect(parseCron("61 * * * *")).toBeNull();
    expect(parseCron("* 25 * * *")).toBeNull();
    expect(parseCron("* * 0 * *")).toBeNull();
    expect(parseCron("* * 32 * *")).toBeNull();
    expect(parseCron("* * * 13 *")).toBeNull();
    expect(parseCron("* * * * 8")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("5-1 * * * *")).toBeNull();
    expect(parseCron("a b c d e")).toBeNull();
    expect(parseCron("1,,2 * * * *")).toBeNull();
    expect(parseCron("1-2-3 * * * *")).toBeNull();
    expect(parseCron("1/2/3 * * * *")).toBeNull();
    expect(parseCron("1-2/* * * * *")).toBeNull(); // step must be numeric
    expect(parseCron("1..2 * * * *")).toBeNull();
  });

  it("keeps range values sorted + deduped", () => {
    const schedule = parseCron("5,1,5,3 * * * *");
    expect(schedule?.minute.values).toEqual([1, 3, 5]);
  });
});

describe("nextOccurrence", () => {
  const from = new Date("2026-08-06T10:30:15.500Z");

  it("every minute: advances exactly one minute, truncating seconds", () => {
    const schedule = parseCron("* * * * *")!;
    const next = nextOccurrence(schedule, from);
    expect(next?.toISOString()).toBe("2026-08-06T10:31:00.000Z");
  });

  it("fixed daily time in UTC", () => {
    const schedule = parseCron("30 9 * * *")!;
    // Later today.
    expect(nextOccurrence(schedule, new Date("2026-08-06T09:29:59Z"))?.toISOString()).toBe(
      "2026-08-06T09:30:00.000Z",
    );
    // Missed today → tomorrow.
    expect(nextOccurrence(schedule, from)?.toISOString()).toBe("2026-08-07T09:30:00.000Z");
  });

  it("monday-only schedule skips the weekend", () => {
    const schedule = parseCron("0 8 * * 1")!;
    // 2026-08-06 is a Thursday.
    const next = nextOccurrence(schedule, from);
    expect(next?.toISOString()).toBe("2026-08-10T08:00:00.000Z"); // Monday
    expect(next?.getUTCDay()).toBe(1);
  });

  it("day-of-month schedule handles month rollover", () => {
    const schedule = parseCron("0 0 1 * *")!;
    const next = nextOccurrence(schedule, from);
    expect(next?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rejects impossible day-of-month by rolling to a real date (Feb 30 never fires in-year)", () => {
    const schedule = parseCron("0 0 30 2 *")!;
    // Feb 30 doesn't exist → next occurrence is February of a future year…
    // but Feb never has day 30 → null within the 4y horizon.
    expect(nextOccurrence(schedule, from)).toBeNull();
  });

  it("Feb 29 lands in 2028 from 2027", () => {
    const schedule = parseCron("0 12 29 2 *")!;
    const next = nextOccurrence(schedule, new Date("2027-03-01T00:00:00Z"));
    expect(next?.toISOString()).toBe("2028-02-29T12:00:00.000Z");
  });

  it("POSIX OR-semantics when dom AND dow are both restricted", () => {
    // Fires on the 1st OR on Mondays.
    const schedule = parseCron("0 9 1 * 1")!;
    const next = nextOccurrence(schedule, from); // Thu 2026-08-06
    // Next Monday is Aug 10 (dom=10 ≠ 1, dow=1 → OR match).
    expect(next?.toISOString()).toBe("2026-08-10T09:00:00.000Z");
  });

  it("step values within a range", () => {
    const schedule = parseCron("0 8-18/4 * * *")!;
    const next = nextOccurrence(schedule, new Date("2026-08-06T09:30:00Z"));
    expect(next?.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });

  it("respects the from boundary strictly (same-minute never re-fires)", () => {
    const schedule = parseCron("30 10 * * *")!;
    const next = nextOccurrence(schedule, new Date("2026-08-06T10:30:00Z"));
    expect(next?.toISOString()).toBe("2026-08-07T10:30:00.000Z");
  });

  it("*/15 minute steps", () => {
    const schedule = parseCron("*/15 * * * *")!;
    expect(nextOccurrence(schedule, from)?.toISOString()).toBe("2026-08-06T10:45:00.000Z");
  });

  it("yearly schedule (specific month + day)", () => {
    const schedule = parseCron("0 0 25 12 *")!;
    const next = nextOccurrence(schedule, from);
    expect(next?.toISOString()).toBe("2026-12-25T00:00:00.000Z");
  });

  it("is deterministic across repeated calls", () => {
    const schedule = parseCron("0 8-18/2 * * 1-5")!;
    const a = nextOccurrence(schedule, from);
    const b = nextOccurrence(schedule, from);
    expect(a?.getTime()).toBe(b?.getTime());
  });
});
