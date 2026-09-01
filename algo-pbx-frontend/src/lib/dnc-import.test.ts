import { describe, expect, it } from "vitest";
import {
  buildImportPreview,
  buildRejectedRowsCsv,
  detectHeaderAndPhoneColumn,
  parseTabularFile,
} from "./dnc-import";

describe("parseTabularFile", () => {
  it("parses plain-text one-number-per-line input (the paste-textarea fallback) as single-cell rows", () => {
    const grid = parseTabularFile("9876543210\n9123456780", "pasted.txt");
    expect(grid).toEqual([["9876543210"], ["9123456780"]]);
  });

  it("parses CSV with a header row and a reason column", () => {
    const grid = parseTabularFile("number,reason\n9876543210,opted out\n9123456780,complaint", "list.csv");
    expect(grid).toEqual([
      ["number", "reason"],
      ["9876543210", "opted out"],
      ["9123456780", "complaint"],
    ]);
  });

  it("strips a leading UTF-8 BOM so it doesn't corrupt the first header cell", () => {
    const grid = parseTabularFile("﻿number\n9876543210", "list.csv");
    expect(grid[0][0]).toBe("number");
  });
});

describe("detectHeaderAndPhoneColumn", () => {
  it("finds a phone column by header name even when it isn't column 0", () => {
    const grid = [
      ["reason", "number"],
      ["opted out", "9876543210"],
    ];
    expect(detectHeaderAndPhoneColumn(grid, "IN")).toEqual({ hasHeader: true, phoneColumnIndex: 1 });
  });

  it("falls back to the parse heuristic when no header name matches", () => {
    // row 0 doesn't parse as a phone number, row 1 does -> row 0 is a header.
    const grid = [
      ["contact list"],
      ["9876543210"],
    ];
    expect(detectHeaderAndPhoneColumn(grid, "IN")).toEqual({ hasHeader: true, phoneColumnIndex: 0 });
  });

  it("treats row 0 as data (no header) when it already parses as a phone number", () => {
    const grid = [["9876543210"], ["9123456780"]];
    expect(detectHeaderAndPhoneColumn(grid, "IN")).toEqual({ hasHeader: false, phoneColumnIndex: 0 });
  });
});

describe("buildImportPreview — the bare 10-digit Indian number case", () => {
  it("imports bare 10-digit Indian numbers under defaultCountry IN (the literal reported bug: these previously imported as zero rows under the AE default)", () => {
    const grid = [["9876543210"], ["9123456780"]];
    const detection = detectHeaderAndPhoneColumn(grid, "IN");
    const preview = buildImportPreview(grid, detection, "IN", 100_000);

    expect(preview.valid).toEqual([
      { raw: "9876543210", e164: "+919876543210" },
      { raw: "9123456780", e164: "+919123456780" },
    ]);
    expect(preview.invalid).toEqual([]);
  });

  it("rejects the same bare 10-digit numbers under the AE default (proves the bug is the default-country mismatch, not the parser)", () => {
    const grid = [["9876543210"], ["9123456780"]];
    const detection = detectHeaderAndPhoneColumn(grid, "AE");
    const preview = buildImportPreview(grid, detection, "AE", 100_000);

    expect(preview.valid).toEqual([]);
    expect(preview.invalid).toEqual(["9876543210", "9123456780"]);
  });

  it("dedupes repeated numbers within the same file without dropping the count silently", () => {
    const grid = [["9876543210"], ["9876543210"], ["9123456780"]];
    const detection = detectHeaderAndPhoneColumn(grid, "IN");
    const preview = buildImportPreview(grid, detection, "IN", 100_000);

    expect(preview.valid).toHaveLength(2);
    expect(preview.duplicatesInFile).toBe(1);
  });

  it("separates unparseable rows into invalid rather than throwing", () => {
    const grid = [["9876543210"], ["not a number"], [""]];
    const detection = detectHeaderAndPhoneColumn(grid, "IN");
    const preview = buildImportPreview(grid, detection, "IN", 100_000);

    expect(preview.valid).toHaveLength(1);
    expect(preview.invalid).toEqual(["not a number"]);
  });

  it("skips the header row when reading the phone column", () => {
    const grid = [
      ["number", "reason"],
      ["9876543210", "opted out"],
    ];
    const detection = detectHeaderAndPhoneColumn(grid, "IN");
    const preview = buildImportPreview(grid, detection, "IN", 100_000);

    expect(preview.valid).toEqual([{ raw: "9876543210", e164: "+919876543210" }]);
  });

  it("caps at maxRows", () => {
    const grid = [["9876543210"], ["9123456780"], ["9988776655"]];
    const detection = detectHeaderAndPhoneColumn(grid, "IN");
    const preview = buildImportPreview(grid, detection, "IN", 2);

    expect(preview.valid).toHaveLength(2);
    expect(preview.total).toBe(2);
  });
});

describe("buildRejectedRowsCsv", () => {
  it("formats a downloadable CSV of rejected raw values", () => {
    expect(buildRejectedRowsCsv(["not a number", "123"])).toBe("rejected_value\nnot a number\n123");
  });

  it("quotes values containing commas", () => {
    expect(buildRejectedRowsCsv(["foo,bar"])).toBe('rejected_value\n"foo,bar"');
  });
});
