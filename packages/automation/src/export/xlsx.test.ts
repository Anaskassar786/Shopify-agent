import { describe, expect, it } from "vitest";
import { buildXlsx, buildZip, columnLetter, crc32 } from "./xlsx";

/**
 * Zip/XLSX structural contract: a hand-rolled parser verifies offsets, CRCs
 * and entry contents — the same invariants Excel validates on open.
 */

interface ParsedEntry {
  name: string;
  crc: number;
  size: number;
  data: Buffer;
}

function parseZip(buffer: Buffer): ParsedEntry[] {
  // Walk local file headers sequentially (STORE entries, no data descriptors).
  const entries: ParsedEntry[] = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const crc = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    entries.push({ name, crc, size, data: buffer.slice(dataStart, dataStart + size) });
    offset = dataStart + size;
  }
  return entries;
}

describe("buildZip", () => {
  it("produces a structurally valid archive with exact CRCs", () => {
    const zip = buildZip([
      { name: "a.txt", data: Buffer.from("hello") },
      { name: "dir/b.txt", data: Buffer.from("world!") },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    // EOCD signature somewhere near the end.
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    const entries = parseZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.txt"]);
    for (const entry of entries) {
      expect(crc32(entry.data)).toBe(entry.crc);
      expect(entry.data.length).toBe(entry.size);
    }
  });

  it("is deterministic (identical input → identical bytes)", () => {
    const a = buildZip([{ name: "x", data: Buffer.from("1") }]);
    const b = buildZip([{ name: "x", data: Buffer.from("1") }]);
    expect(a.equals(b)).toBe(true);
  });

  it("crc32 matches the known vector (123456789 → 0xCBF43926)", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("columnLetter", () => {
  it("maps indices to spreadsheet letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(51)).toBe("AZ");
    expect(columnLetter(52)).toBe("BA");
  });
});

describe("buildXlsx", () => {
  const headers = ["Email", "Orders", "Active"];
  const rows = [
    ["ada@example.com", 7, true],
    ['=bad()"&<>', null, false],
  ] as const;

  function sheetXml(zip: Buffer): string {
    const entry = parseZip(zip).find((e) => e.name === "xl/worksheets/sheet1.xml");
    if (entry === undefined) throw new Error("sheet missing");
    return entry.data.toString("utf8");
  }

  it("contains the full part set Excel requires", () => {
    const zip = buildXlsx(headers, rows);
    const names = parseZip(zip).map((e) => e.name);
    expect(names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("renders strings inline, numbers as v, escaped XML, and escapes formulas", () => {
    const xml = sheetXml(buildXlsx(headers, rows));
    expect(xml).toContain('<row r="1">');
    expect(xml).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Email</t></is></c>');
    expect(xml).toContain('<c r="B2"><v>7</v></c>');
    expect(xml).toContain("<is><t xml:space=\"preserve\">TRUE</t></is>");
    expect(xml).toContain("&apos;=bad()&quot;&amp;&lt;&gt;");
    expect(xml).toContain('<c r="B3"/>'); // null cell
  });

  it("rejects empty headers", () => {
    expect(() => buildXlsx([], [])).toThrow(/header count/);
  });
});
