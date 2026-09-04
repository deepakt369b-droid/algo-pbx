import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/audit?action=&actorEmail=&limit= — the viewer this
// table never had (Loop C3): rows have been written since Phase D
// (recording hide/hard-delete, intervention, settings.update, and now
// user.disable/enable, user.password_reset_*, extension.delete,
// invite.consume) but nothing in the product ever surfaced them —
// exactly the "AuditLog has no viewer UI" gap LLM.md §7 flagged.
// requireStaffSession, same tier as /admin/sign-ins/reports: reviewing
// this is a supervisor-level visibility need, not ADMIN-only.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const action = request.nextUrl.searchParams.get("action") || undefined;
  const actorEmail = request.nextUrl.searchParams.get("actorEmail") || undefined;
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 200), 500);

  const logs = await db.auditLog.findMany({
    where: {
      action: action ? { contains: action } : undefined,
      actor: actorEmail ? { email: { contains: actorEmail, mode: "insensitive" } } : undefined,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: { select: { id: true, name: true, email: true, role: true } } },
  });

  return NextResponse.json({ logs });
}
