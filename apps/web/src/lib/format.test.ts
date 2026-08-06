import { describe, expect, it } from "vitest";
import { daysUntil, formatDateTime, formatDecimalMoney, formatRelativeTime } from "./format";

const NOW = new Date("2026-08-05T12:00:00.000Z");

describe("formatDateTime", () => {
  it("formats ISO timestamps and tolerates junk", () => {
    expect(formatDateTime("2026-08-05T08:04:00.000Z")).toContain("Aug 5, 2026");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  it("buckets recency", () => {
    expect(formatRelativeTime("2026-08-05T11:59:40.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("2026-08-05T11:45:00.000Z", NOW)).toBe("15m ago");
    expect(formatRelativeTime("2026-08-05T06:00:00.000Z", NOW)).toBe("6h ago");
    expect(formatRelativeTime("2026-08-01T12:00:00.000Z", NOW)).toBe("4d ago");
    expect(formatRelativeTime("2026-04-01T12:00:00.000Z", NOW)).toContain("Apr 1");
  });

  it("handles missing values and clock skew", () => {
    expect(formatRelativeTime(null, NOW)).toBe("never");
    expect(formatRelativeTime("junk", NOW)).toBe("never");
    expect(formatRelativeTime("2026-08-05T12:05:00.000Z", NOW)).toBe("just now");
  });
});

describe("formatDecimalMoney", () => {
  it("formats numeric-string decimals as money", () => {
    expect(formatDecimalMoney("1299.00", "USD")).toBe("$1,299.00");
    expect(formatDecimalMoney("49", "USD")).toBe("$49.00");
  });

  it("returns em-dash for null/garbage", () => {
    expect(formatDecimalMoney(null, "USD")).toBe("—");
    expect(formatDecimalMoney("abc", "USD")).toBe("—");
  });
});

describe("daysUntil", () => {
  it("returns whole days remaining, floored at zero", () => {
    expect(daysUntil("2026-08-08T12:00:00.000Z", NOW)).toBe(3);
    expect(daysUntil("2026-08-01T12:00:00.000Z", NOW)).toBe(0);
  });

  it("returns null without a date", () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil("junk", NOW)).toBeNull();
  });
});
