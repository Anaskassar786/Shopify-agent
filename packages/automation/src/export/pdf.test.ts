import { describe, expect, it } from "vitest";
import { buildPdf } from "./pdf";

/**
 * PDF structural contract: parse the xref table and verify every referenced
 * object offset lands on "N 0 obj" — the exact check viewers do on load.
 */

function parseXrefs(buffer: Buffer): { offsets: number[]; startxref: number } {
  const text = buffer.toString("latin1");
  const xrefAt = text.indexOf("\nxref\n");
  if (xrefAt < 0) throw new Error("no xref table");
  const header = text.slice(xrefAt + 6);
  const countMatch = /^0 (\d+)\n/.exec(header);
  if (countMatch === null) throw new Error("bad xref header");
  const count = Number(countMatch[1]);
  const entries = header.slice(countMatch[0].length).split("\n");
  const offsets: number[] = [];
  for (let i = 0; i < count; i += 1) {
    offsets.push(Number(entries[i]!.slice(0, 10)));
  }
  const startMatch = /startxref\n(\d+)\n/.exec(text);
  return { offsets, startxref: Number(startMatch![1]) };
}

describe("buildPdf", () => {
  const headers = ["Email", "Name", "Orders", "Total"];
  const rows = Array.from({ length: 120 }, (_, i) => [
    `user${i}@example.com`,
    `Customer (Test) ${i} \\ "q"`,
    i,
    `$${(i * 7.5).toFixed(2)}`,
  ]);

  it("emits a well-formed document with a valid xref table", () => {
    const pdf = buildPdf({ title: "Customers Export", subtitle: "test", headers, rows });
    expect(pdf.slice(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(pdf.slice(pdf.length - 6).toString("latin1")).toContain("%%EOF");
    const { offsets, startxref } = parseXrefs(pdf);
    // Every non-free object offset lands on "<n> 0 obj".
    for (let i = 1; i < offsets.length; i += 1) {
      const at = pdf.slice(offsets[i]!, offsets[i]! + 20).toString("latin1");
      expect(at.startsWith(`${i} 0 obj`)).toBe(true);
    }
    // startxref points at the xref keyword.
    expect(pdf.slice(startxref, startxref + 4).toString("latin1")).toBe("xref");
  });

  it("paginates long tables and repeats the header row", () => {
    const pdf = buildPdf({ title: "T", headers, rows });
    const text = pdf.toString("latin1");
    const pageObjects = text.match(/\/Type \/Page \/Parent/g) ?? [];
    expect(pageObjects.length).toBeGreaterThan(1);
    // Header text appears once per page.
    const headerOccurrences = text.split("(Email)").length - 1;
    expect(headerOccurrences).toBe(pageObjects.length);
  });

  it("escapes parens and backslashes in cell text", () => {
    const pdf = buildPdf({ title: "T)", headers: ["A"], rows: [["(x) \\ y"]] });
    const text = pdf.toString("latin1");
    expect(text).toContain("\\(x\\) \\\\ y");
    expect(text).toContain("T\\)");
  });

  it("sanitizes non-latin characters instead of emitting invalid bytes", () => {
    const pdf = buildPdf({ title: "T", headers: ["A"], rows: [["café — naïve"]] });
    const text = pdf.toString("latin1");
    expect(text).not.toContain("café");
    expect(text).toContain("caf");
  });

  it("handles an empty row set (blank page, header only)", () => {
    const pdf = buildPdf({ title: "Empty", headers: ["A", "B"], rows: [] });
    expect(pdf.slice(0, 8).toString("latin1")).toBe("%PDF-1.4");
  });

  it("rejects too many columns", () => {
    const many = Array.from({ length: 20 }, (_, i) => `c${i}`);
    expect(() => buildPdf({ title: "T", headers: many, rows: [] })).toThrow(/header count/);
  });

  it("is deterministic for identical input", () => {
    const a = buildPdf({ title: "T", headers, rows: rows.slice(0, 5) });
    const b = buildPdf({ title: "T", headers, rows: rows.slice(0, 5) });
    expect(a.equals(b)).toBe(true);
  });
});
