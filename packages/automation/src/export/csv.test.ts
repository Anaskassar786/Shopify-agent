import { describe, expect, it } from "vitest";
import { buildCsv } from "./csv";

describe("buildCsv", () => {
  it("emits RFC 4180 rows with CRLF and a UTF-8 BOM", () => {
    const out = buildCsv(["A", "B"], [
      [1, "x"],
      [2, "y"],
    ]).toString("utf8");
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain("A,B\r\n1,x\r\n2,y\r\n");
  });

  it("quotes cells containing comma, quote, or newline", () => {
    const out = buildCsv(["t"], [['say "hi", ok'], ["line1\nline2"], ["plain"]]).toString("utf8");
    expect(out).toContain('"say ""hi"", ok"');
    expect(out).toContain('"line1\nline2"');
    expect(out).toContain("plain\r\n");
  });

  it("neutralizes formula injection (=,+,-,@,tab prefixes)", () => {
    const out = buildCsv(["f"], [["=SUM(A1:A2)"], ["+cmd"], ["-10+1"], ["@import"], ["\teval"]]).toString("utf8");
    for (const bad of ["'=SUM", "'+cmd", "'-10+1", "'@import", "'\teval"]) {
      expect(out).toContain(bad);
    }
  });

  it("renders nulls empty and booleans as TRUE/FALSE", () => {
    const out = buildCsv(["a", "b", "c"], [[null, true, false]]).toString("utf8");
    expect(out).toContain(",TRUE,FALSE");
  });

  it("renders non-finite numbers as empty cells (never NaN the CSV)", () => {
    const out = buildCsv(["n"], [[Number.NaN], [Number.POSITIVE_INFINITY]]).toString("utf8");
    const lines = out.split("\r\n");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("");
  });
});
