import { describe, it, expect } from "vitest";
import { toAuditCsv, csvCell, auditCsvFilename, AUDIT_CSV_HEADERS, type AuditCsvRow } from "./audit-csv";

const AT = new Date("2026-09-05T12:34:56.000Z");

function row(o: Partial<AuditCsvRow> = {}): AuditCsvRow {
  return {
    createdAt: AT,
    action: "billing.mark_paid",
    platformUserEmail: "owner@example.com",
    tenantSlug: "acme",
    reason: "paid by bank transfer",
    metadata: { before: { seats: 5 } },
    ...o,
  };
}

describe("csvCell — RFC 4180 quoting", () => {
  it("quotes every value", () => {
    expect(csvCell("plain")).toBe('"plain"');
  });

  it("doubles internal quotes", () => {
    expect(csvCell('he said "no"')).toBe('"he said ""no"""');
  });

  it("keeps a comma inside one field", () => {
    // The bug this prevents: an unescaped comma shifts every later column,
    // silently attributing an action to the wrong tenant.
    expect(csvCell("late, disputed, then settled")).toBe('"late, disputed, then settled"');
  });

  it("survives newlines in a reason", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("renders null and undefined as an empty field", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
});

describe("csvCell — formula injection", () => {
  // Reasons are free text typed by operators, and Excel/Sheets execute a
  // leading =, +, - or @. Without this, an exported reason becomes live
  // content in the auditor's spreadsheet.
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "=HYPERLINK(\"http://x\")"])(
    "neutralises %s with a leading apostrophe",
    (payload) => {
      const cell = csvCell(payload);
      expect(cell.startsWith("\"'")).toBe(true);
      expect(cell).toContain(payload.replace(/"/g, '""'));
    }
  );

  it("leaves ordinary text untouched", () => {
    expect(csvCell("paid on time")).toBe('"paid on time"');
  });

  it("guards tab and carriage-return leads too", () => {
    expect(csvCell("\t=cmd").startsWith("\"'")).toBe(true);
  });
});

describe("toAuditCsv", () => {
  it("emits the documented header row first", () => {
    const csv = toAuditCsv([]);
    expect(csv.split("\r\n")[0]).toBe(AUDIT_CSV_HEADERS.map((h) => `"${h}"`).join(","));
  });

  it("writes one line per row, CRLF terminated", () => {
    const csv = toAuditCsv([row(), row()]);
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("writes timestamps as ISO 8601 UTC, not a locale format", () => {
    expect(toAuditCsv([row()])).toContain('"2026-09-05T12:34:56.000Z"');
  });

  it("accepts a date that arrived as a string", () => {
    expect(toAuditCsv([row({ createdAt: "2026-09-05T12:34:56.000Z" })])).toContain(
      '"2026-09-05T12:34:56.000Z"'
    );
  });

  it("leaves the timestamp empty rather than writing 'Invalid Date'", () => {
    expect(toAuditCsv([row({ createdAt: "not a date" })])).toContain('""');
  });

  it("serialises metadata as JSON in one field", () => {
    const csv = toAuditCsv([row({ metadata: { a: 1, b: "x" } })]);
    expect(csv).toContain('"{""a"":1,""b"":""x""}"');
  });

  it("handles a null actor and tenant", () => {
    const csv = toAuditCsv([row({ platformUserEmail: null, tenantSlug: null, reason: null })]);
    expect(csv.split("\r\n")[1]).toBe(
      '"2026-09-05T12:34:56.000Z","billing.mark_paid","","","","{""before"":{""seats"":5}}"'
    );
  });

  it("keeps column alignment when a reason contains commas and quotes", () => {
    const csv = toAuditCsv([row({ reason: 'late, then "settled"' })]);
    const line = csv.split("\r\n")[1];
    // Six fields, still, despite the embedded punctuation.
    expect(line.match(/(^|,)"/g)).toHaveLength(6);
  });
});

describe("auditCsvFilename", () => {
  it("is filesystem-safe and carries the export moment", () => {
    const name = auditCsvFilename(AT);
    expect(name).toBe("platform-audit-2026-09-05T12-34-56-000Z.csv");
    expect(name).not.toMatch(/[:*?"<>|]/);
  });
});
