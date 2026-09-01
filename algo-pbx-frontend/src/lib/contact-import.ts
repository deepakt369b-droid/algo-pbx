import type { CountryCode } from "libphonenumber-js";
import { normalizeToE164 } from "./phone-normalize";
import { detectHeaderAndPhoneColumn, type HeaderDetection } from "./dnc-import";

// Pure parsing/validation logic for /admin/contacts's bulk import — the
// Contact equivalent of src/lib/dnc-import.ts. Deliberately does NOT
// duplicate parseTabularFile/detectHeaderAndPhoneColumn/buildRejectedRowsCsv
// (imported/re-exported from dnc-import.ts instead, see that file) since
// the phone-column parsing heuristic is identical for both features; only
// the name-column detection and the {name, phone} preview shape are new
// here. Same DB-free, unit-testable-under-node-vitest convention.
export { parseTabularFile, detectHeaderAndPhoneColumn, buildRejectedRowsCsv } from "./dnc-import";
export type { HeaderDetection } from "./dnc-import";

const NAME_HEADER_HINTS = ["name", "contact", "customer", "client"];

/** Column names that make a column look like a name column rather than a
 * phone column. "contact" is intentionally in both this list and
 * dnc-import's HEADER_NAME_HINTS — a column literally titled "Contact"
 * genuinely is ambiguous between the two on name alone, so the caller
 * (detectNameColumn) always excludes whatever column already won as the
 * phone column before considering this list, which resolves the overlap
 * without either heuristic needing to know about the other. */
function looksLikeNameHeader(cell: string): boolean {
  const lower = cell.trim().toLowerCase();
  return NAME_HEADER_HINTS.some((hint) => lower.includes(hint));
}

export interface ContactHeaderDetection extends HeaderDetection {
  nameColumnIndex: number | null;
}

/** Extends detectHeaderAndPhoneColumn with a name column. Signals, in order:
 * 1. A header cell (other than the phone column) matching a name hint.
 * 2. Otherwise, when there IS a header row, the first remaining column
 *    that isn't the phone column — most contact exports are exactly
 *    {name, phone} or {phone, name} in some order, so "the other column"
 *    is a reasonable default rather than leaving it unmapped.
 * 3. No header row at all (bare phone-per-line paste, same shape DNC
 *    accepts): no name column — `nameColumnIndex: null`, meaning every
 *    imported contact gets a null displayName rather than guessing.
 * The admin can always override the picked column in the preview UI, same
 * as the phone column already works for DNC import. */
export function detectNameColumn(
  grid: string[][],
  phoneDetection: HeaderDetection
): number | null {
  if (!phoneDetection.hasHeader || grid.length === 0) return null;

  const headerRow = grid[0];
  const namedIndex = headerRow.findIndex(
    (cell, i) => i !== phoneDetection.phoneColumnIndex && looksLikeNameHeader(cell)
  );
  if (namedIndex !== -1) return namedIndex;

  const otherIndex = headerRow.findIndex((_, i) => i !== phoneDetection.phoneColumnIndex);
  return otherIndex !== -1 ? otherIndex : null;
}

export function detectContactHeaders(
  grid: string[][],
  defaultCountry: CountryCode
): ContactHeaderDetection {
  const phoneDetection = detectHeaderAndPhoneColumn(grid, defaultCountry);
  return { ...phoneDetection, nameColumnIndex: detectNameColumn(grid, phoneDetection) };
}

export interface ContactImportPreview {
  total: number;
  valid: { raw: string; e164: string; name: string | null }[];
  invalid: string[];
  duplicatesInFile: number;
}

/** Contact analogue of dnc-import's buildImportPreview: dedupes within the
 * file on E.164 number (same reasoning — later occurrences tallied as
 * duplicatesInFile, not double-inserted) and carries the paired name
 * column through, trimmed to null when blank rather than an empty string
 * (matches Contact.displayName's nullable-not-empty-string convention
 * elsewhere in this codebase, e.g. the PATCH route's `displayName ?? null`
 * handling). Does not check against existing Contact rows — same
 * division of responsibility as dnc-import.ts: the route's
 * createMany({ skipDuplicates: true }) is the authoritative, race-free
 * check against the DB. */
export function buildContactImportPreview(
  grid: string[][],
  detection: ContactHeaderDetection,
  defaultCountry: CountryCode,
  maxRows: number
): ContactImportPreview {
  const dataRows = detection.hasHeader ? grid.slice(1) : grid;
  const seen = new Set<string>();
  const valid: { raw: string; e164: string; name: string | null }[] = [];
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
    const name = detection.nameColumnIndex !== null ? (row[detection.nameColumnIndex] ?? "").trim() : "";
    valid.push({ raw, e164, name: name || null });
  }

  return { total: Math.min(dataRows.length, maxRows), valid, invalid, duplicatesInFile };
}
