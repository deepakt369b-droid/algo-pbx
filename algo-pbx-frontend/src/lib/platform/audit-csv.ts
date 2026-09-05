// CSV serialisation for the audit export.
//
// This is compliance evidence, so it gets handled like evidence rather than
// like a convenience download:
//
//   - Every field is quoted and internal quotes are doubled (RFC 4180). An
//     unescaped reason containing a comma would silently shift every
//     subsequent column, producing an export that LOOKS fine and attributes
//     actions to the wrong tenant.
//   - Formula injection is neutralised. A cell starting = + - or @ is
//     executed as a formula by Excel and Sheets, so a reason typed as
//     "=HYPERLINK(...)" becomes live content in whoever opens the file. Since
//     reasons are free text written by operators, that is a real path from
//     "someone typed something odd" to "the auditor's spreadsheet ran it".
//   - Timestamps are ISO 8601 UTC. A locale-formatted date in an evidence
//     file is ambiguous to the reader and unsortable to a tool.

export interface AuditCsvRow {
  createdAt: Date | string;
  action: string;
  platformUserEmail: string | null;
  tenantSlug: string | null;
  reason: string | null;
  metadata: unknown;
}

export const AUDIT_CSV_HEADERS = [
  "timestamp_utc",
  "action",
  "actor_email",
  "tenant_slug",
  "reason",
  "metadata_json",
] as const;

/** Quote per RFC 4180 and defuse spreadsheet formula execution. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';

  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) s = "";

  // Formula injection: prefix with a single quote so the cell is read as
  // text. Done BEFORE quoting so the guard ends up inside the quoted field.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;

  return `"${s.replace(/"/g, '""')}"`;
}

function isoOf(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function toAuditCsv(rows: readonly AuditCsvRow[]): string {
  const lines = [AUDIT_CSV_HEADERS.map(csvCell).join(",")];

  for (const r of rows) {
    lines.push(
      [
        csvCell(isoOf(r.createdAt)),
        csvCell(r.action),
        csvCell(r.platformUserEmail),
        csvCell(r.tenantSlug),
        csvCell(r.reason),
        csvCell(r.metadata === null || r.metadata === undefined ? "" : JSON.stringify(r.metadata)),
      ].join(",")
    );
  }

  // CRLF per RFC 4180, and a trailing newline so the last row is terminated.
  return lines.join("\r\n") + "\r\n";
}

/** Filename carrying the export moment, so two exports never collide in a
 * downloads folder and the file is self-describing once detached from the UI
 * that produced it. */
export function auditCsvFilename(now: Date = new Date()): string {
  return `platform-audit-${now.toISOString().replace(/[:.]/g, "-")}.csv`;
}
