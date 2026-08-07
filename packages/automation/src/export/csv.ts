/**
 * CSV writer (M6 exports). RFC 4180: CRLF row terminators, quoting on
 * comma/quote/newline, doubled quotes. A UTF-8 BOM prefixes the payload so
 * spreadsheet apps auto-detect encoding (merchant-facing artifact).
 * Formula-injection hardening: string cells starting with = + - @ or a tab
 * get a leading apostrophe (Excel escape) — exports must never carry live
 * formulas into a merchant's spreadsheet.
 */

export interface CsvColumn {
  readonly header: string;
}

export type CsvCell = string | number | boolean | null;

const BOM = "﻿";

function escapeCell(cell: CsvCell): string {
  if (cell === null) return "";
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) return "";
    return String(cell);
  }
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  let value = cell;
  if (/^[=+\-@\t]/.test(value)) value = `'${value}`;
  if (/[",\r\n]/.test(value)) {
    value = `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function buildCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): Buffer {
  const lines: string[] = [];
  lines.push(headers.map((h) => escapeCell(h)).join(","));
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(","));
  }
  return Buffer.from(`${BOM}${lines.join("\r\n")}\r\n`, "utf8");
}
