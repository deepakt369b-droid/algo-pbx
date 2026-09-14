import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireStaffSession } from "@/lib/auth-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/admin/ai/call-sessions?uniqueIds=<comma-separated CDR uniqueIds>
//   or ?summary=1&from=&to= (reports hub's "AI-handled calls" card)
//
// New for W7, task 4 ("CDR/reports merge") — flagged the same as
// ../agents/**: not pre-assigned to any node, but the CDR/reports admin
// pages need a way to tell which calls were AI-handled and to fetch their
// transcript, and no existing route (GET /api/cdr, the reports routes)
// selects AiCallSession at all. Deliberately its own read-only endpoint
// instead of editing api/cdr/route.ts or the reports routes in place —
// this keeps this pass's edits inside src/app/api/admin/ai/** rather than
// touching another node's/feature's files, at the cost of one extra
// client-side fetch-and-merge in cdr-table.tsx / telephony-tab.tsx.
//
// AiCallSession links to CallDetailRecord by `cdrUniqueId`, NOT a real FK
// (contracts.md — two independent writers), so this is a plain `in` lookup,
// tenant-scoped by the guard's `db` like every other admin route. The
// summary mode counts by AiCallSession.createdAt (its own write time, close
// enough to call time for a "how many AI calls this period" stat — this
// deliberately doesn't need billing-grade precision per the task).
const UniqueIdsQuerySchema = z.object({
  uniqueIds: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0 && arr.length <= 200, "1-200 uniqueIds"),
});

const SummaryQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

export const GET = withApiErrorHandler(async function GET(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const { searchParams } = new URL(req.url);

  if (searchParams.get("summary")) {
    const parsed = SummaryQuerySchema.safeParse({
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid query parameters", details: parsed.error.flatten() }, { status: 400 });
    }
    const { from, to } = parsed.data;
    const count = await db.aiCallSession.count({
      where: {
        createdAt: {
          gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
          lte: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
        },
      },
    });
    return NextResponse.json({ count });
  }

  const parsed = UniqueIdsQuerySchema.safeParse({ uniqueIds: searchParams.get("uniqueIds") ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters", details: parsed.error.flatten() }, { status: 400 });
  }

  const rows = await db.aiCallSession.findMany({
    where: { cdrUniqueId: { in: parsed.data.uniqueIds } },
    select: {
      cdrUniqueId: true,
      transcript: true,
      summary: true,
      outcome: true,
      handoffExtensionId: true,
      aiAgent: { select: { name: true } },
    },
  });

  // Keyed by cdrUniqueId for O(1) client-side lookup against the CDR rows
  // already on screen — the whole point of this route is "which of the
  // uniqueIds I already have were AI-handled", not a standalone list.
  const sessions: Record<string, (typeof rows)[number]> = {};
  for (const row of rows) sessions[row.cdrUniqueId] = row;

  return NextResponse.json({ sessions });
});
