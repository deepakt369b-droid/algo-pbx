import { NextRequest, NextResponse } from "next/server";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { queryAuditForExport, MAX_EXPORT_ROWS } from "@/lib/platform/audit-query";
import { toAuditCsv, auditCsvFilename } from "@/lib/platform/audit-csv";
import { recordPlatformAudit } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// GET /api/platform/audit/export — CSV of the current filter.
//
// The export is itself audited. That is not bureaucratic symmetry: an export
// is a bulk read of the record of every consequential action taken across
// every customer, and "who pulled the full audit history, when, and with what
// filter" is exactly the sort of thing the audit log exists to answer. An
// audit system that cannot account for its own exports has a blind spot at
// the point it matters most.
export const GET = withApiErrorHandler(async function GET(req: NextRequest) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const sp = req.nextUrl.searchParams;
  const filters = {
    action: sp.get("action") ?? undefined,
    actorId: sp.get("actorId") ?? undefined,
    tenantId: sp.get("tenantId") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
  };

  const rows = await queryAuditForExport(filters);
  const csv = toAuditCsv(rows);
  const filename = auditCsvFilename();

  await recordPlatformAudit({
    action: "audit.export",
    platformUserId: guard.session.user.id,
    metadata: { filters, rowCount: rows.length, truncated: rows.length >= MAX_EXPORT_ROWS },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      // UTF-8 declared explicitly: reasons are free text and will contain
      // non-ASCII, and a spreadsheet guessing the encoding mangles it.
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Evidence, not a cacheable resource.
      "Cache-Control": "no-store",
    },
  });
});
