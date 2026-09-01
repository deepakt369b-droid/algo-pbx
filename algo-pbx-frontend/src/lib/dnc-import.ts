import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { CountryCode } from "libphonenumber-js";
import { normalizeToE164 } from "./phone-normalize";

// Pure parsing/validation logic for /admin/dnc's bulk import, split out of
// the route handler and the page so it's unit-testable under this repo's
// `environment: "node"` vitest config (no DOM needed — see
// src/lib/messaging/whatsapp-deep-link.ts for the precedent this follows).
// Everything here is deterministic and DB-free; the route wires it to
// Prisma, the page wires it to fetch()/drag-drop.

const HEADER_NAME_HINTS = ["phone", "number", "mobile", "msisdn", "contact"];

/** Column names that make a first row look like a header rather than data —
 * checked before the "does it parse as a number" heuristic since a header
 * like "Phone" is itself unparseable anyway, but a header like "Ext" isn't
 * an obviously-non-numeric giveaway on its own. */
function looksLikeHeaderName(cell: string): boolean {
  const lower = cell.trim().toLowerCase();
  return HEADER_NAME_HINTS.some((hint) => lower.includes(hint));
}

/** Parses raw upload bytes/text into a rectangular grid of string cells.
 * `filename` picks the parser: .xlsx/.xls go through SheetJS, everything
 * else (including pasted-textarea text, which has no filename) is treated
 * as CSV/plain-text-one-per-line via PapaParse (which degrades gracefully
 * to one cell per line when there are no commas). Strips a UTF-8 BOM,
 * which Excel-exported CSVs commonly carry and which would otherwise land
 * inside the first header/phone cell and break header detection. */
export function parseTabularFile(input: string | ArrayBuffer, filename: string): string[][] {
  const isSpreadsheet = /\.xlsx?$/i.test(filename);

  if (isSpreadsheet) {
    const workbook = XLSX.read(input, { type: typeof input === "string" ? "binary" : "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) return [];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(firstSheet, { header: 1, blankrows: false, raw: false });
    return rows.map((row) => row.map((cell) => String(cell ?? "").trim()));
  }

  const text = typeof input === "string" ? input : new TextDecoder("utf-8").decode(input);
  const stripped = text.replace(/^﻿/, "");
  const result = Papa.parse<string[]>(stripped, { skipEmptyLines: true });
  return result.data.map((row) => row.map((cell) => cell.trim()));
}

export interface HeaderDetection {
  hasHeader: boolean;
  phoneColumnIndex: number;
}

/** Decides whether row 0 is a header and which column holds the phone
 * number. Two signals, in order:
 * 1. A cell in row 0 whose name matches a phone-ish hint ("phone", "number",
 *    "mobile", "msisdn", "contact") — that row is the header, that column
 *    is the phone column.
 * 2. Otherwise, heuristic: if row 0 fails to parse as a phone number under
 *    `defaultCountry` but row 1 (when present) does, row 0 is a header;
 *    the phone column is whichever of row 1's columns parses.
 * Falls back to "no header, column 0" when nothing else resolves — the
 * historical behavior this replaces, kept as the safe default rather than
 * guessing wrong on an ambiguous single-column file. */
export function detectHeaderAndPhoneColumn(grid: string[][], defaultCountry: CountryCode): HeaderDetection {
  if (grid.length === 0) return { hasHeader: false, phoneColumnIndex: 0 };

  const headerRow = grid[0];
  const namedIndex = headerRow.findIndex((cell) => looksLikeHeaderName(cell));
  if (namedIndex !== -1) return { hasHeader: true, phoneColumnIndex: namedIndex };

  const row0ParsesAsPhone = headerRow.some((cell) => normalizeToE164(cell, defaultCountry) !== null);
  if (!row0ParsesAsPhone && grid.length > 1) {
    const row1 = grid[1];
    const dataIndex = row1.findIndex((cell) => normalizeToE164(cell, defaultCountry) !== null);
    if (dataIndex !== -1) return { hasHeader: true, phoneColumnIndex: dataIndex };
  }

  // Single-column file whose one row doesn't parse (e.g. a lone "Phone"
  // header with no data yet) — still worth flagging as a header so it
  // doesn't get counted as one bogus "invalid" row.
  if (!row0ParsesAsPhone && grid.length === 1 && headerRow.length === 1) {
    return { hasHeader: true, phoneColumnIndex: 0 };
  }

  return { hasHeader: false, phoneColumnIndex: 0 };
}

export interface ImportPreview {
  total: number;
  valid: { raw: string; e164: string }[];
  invalid: string[];
  duplicatesInFile: number;
}

/** Builds the preview/commit set: dedupes within the file itself (later
 * occurrences of an already-seen E.164 number are tallied as
 * `duplicatesInFile` but not double-inserted) and separates numbers that
 * fail to parse under `defaultCountry` into `invalid`. Does NOT check
 * against existing DoNotCallEntry rows — the route does that via
 * `createMany({ skipDuplicates: true })`, which is the authoritative,
 * race-free check; duplicating it here would just be a second source of
 * truth that can drift. */
export function buildImportPreview(
  grid: string[][],
  detection: HeaderDetection,
  defaultCountry: CountryCode,
  maxRows: number
): ImportPreview {
  const dataRows = detection.hasHeader ? grid.slice(1) : grid;
  const seen = new Set<string>();
  const valid: { raw: string; e164: string }[] = [];
  const invalid: string[] = [];
  let duplicatesInFile = 0;

  for (const row of dataRows.slice(0, maxRows)) {
    const raw = (row[detection.phoneColumnIndex] ?? "").trim();
    if (!raw) continue;

    const e164 = normalizeToE164(raw, defaultCountry);
    if (!e164) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(e164)) {
      duplicatesInFile++;
      continue;
    }
    seen.add(e164);
    valid.push({ raw, e164 });
  }

  return { total: Math.min(dataRows.length, maxRows), valid, invalid, duplicatesInFile };
}

/** Formats a rejected-rows report as downloadable CSV text — the numbers
 * that failed to parse, so an admin can see exactly what was skipped
 * instead of a bare count. Cheap to build since `invalid` is already in
 * memory from buildImportPreview(). */
export function buildRejectedRowsCsv(invalid: string[]): string {
  const header = "rejected_value";
  return [header, ...invalid.map((v) => (v.includes(",") ? `"${v.replace(/"/g, '""')}"` : v))].join("\n");
}
