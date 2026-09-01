import { describe, expect, it } from "vitest";
import {
  buildContactImportPreview,
  detectContactHeaders,
  detectNameColumn,
  parseTabularFile,
} from "./contact-import";
import { detectHeaderAndPhoneColumn } from "./dnc-import";

describe("detectNameColumn", () => {
  it("finds a name column by header hint, excluding whichever column is already the phone column", () => {
    const grid = [
      ["Name", "Phone"],
      ["Asha Rao", "9876543210"],
    ];
    const phoneDetection = detectHeaderAndPhoneColumn(grid, "IN");
    expect(phoneDetection.phoneColumnIndex).toBe(1);
    expect(detectNameColumn(grid, phoneDetection)).toBe(0);
  });

  it("falls back to 'the other column' when there's a header but no name-ish column name", () => {
    const grid = [
      ["Full Legal Title", "MSISDN"],
      ["Vikram Shah", "9123456780"],
    ];
    const phoneDetection = detectHeaderAndPhoneColumn(grid, "IN");
    expect(phoneDetection.phoneColumnIndex).toBe(1);
    // "Full Legal Title" doesn't match any NAME_HEADER_HINTS, so this falls
    // through to "the other (non-phone) column" rather than staying unmapped.
    expect(detectNameColumn(grid, phoneDetection)).toBe(0);
  });

  it("returns null when there's no header row at all (bare phone-per-line paste)", () => {
    const grid = [["9876543210"], ["9123456780"]];
    const phoneDetection = detectHeaderAndPhoneColumn(grid, "IN");
    expect(phoneDetection.hasHeader).toBe(false);
    expect(detectNameColumn(grid, phoneDetection)).toBeNull();
  });
});

describe("detectContactHeaders", () => {
  it("combines phone and name detection in one call", () => {
    const grid = [
      ["number", "name"],
      ["9876543210", "Asha Rao"],
    ];
    expect(detectContactHeaders(grid, "IN")).toEqual({
      hasHeader: true,
      phoneColumnIndex: 0,
      nameColumnIndex: 1,
    });
  });
});

describe("buildContactImportPreview", () => {
  it("pairs name with phone, treating a blank name cell as null rather than an empty string", () => {
    const grid = [
      ["name", "number"],
      ["Asha Rao", "9876543210"],
      ["", "9123456780"],
    ];
    const detection = detectContactHeaders(grid, "IN");
    const preview = buildContactImportPreview(grid, detection, "IN", 100_000);

    expect(preview.valid).toEqual([
      { raw: "9876543210", e164: "+919876543210", name: "Asha Rao" },
      { raw: "9123456780", e164: "+919123456780", name: null },
    ]);
    expect(preview.invalid).toEqual([]);
    expect(preview.duplicatesInFile).toBe(0);
  });

  it("dedupes within the file on normalized E.164, keeping the first occurrence's name", () => {
    const grid = [
      ["name", "number"],
      ["Asha Rao", "9876543210"],
      ["Duplicate Asha", "+919876543210"],
    ];
    const detection = detectContactHeaders(grid, "IN");
    const preview = buildContactImportPreview(grid, detection, "IN", 100_000);

    expect(preview.valid).toEqual([{ raw: "9876543210", e164: "+919876543210", name: "Asha Rao" }]);
    expect(preview.duplicatesInFile).toBe(1);
  });

  it("collects unparseable phone values into invalid rather than dropping them silently", () => {
    const grid = [
      ["name", "number"],
      ["Bad Row", "not-a-phone"],
      ["Asha Rao", "9876543210"],
    ];
    const detection = detectContactHeaders(grid, "IN");
    const preview = buildContactImportPreview(grid, detection, "IN", 100_000);

    expect(preview.invalid).toEqual(["not-a-phone"]);
    expect(preview.valid).toHaveLength(1);
  });

  it("handles a bare phone-per-line paste with no name column at all", () => {
    const grid = parseTabularFile("9876543210\n9123456780", "pasted.txt");
    const detection = detectContactHeaders(grid, "IN");
    const preview = buildContactImportPreview(grid, detection, "IN", 100_000);

    expect(preview.valid).toEqual([
      { raw: "9876543210", e164: "+919876543210", name: null },
      { raw: "9123456780", e164: "+919123456780", name: null },
    ]);
  });
});
