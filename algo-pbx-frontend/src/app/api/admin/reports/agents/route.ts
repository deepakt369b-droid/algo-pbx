import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/reports/agents — the option list for <ReportFilters>'s agent
// picker. Every signed-in user who can own call/CRM work (AGENT + SUPERVISOR
// + ADMIN all can be a deal owner or disposition author), with their current
// extension number for display.
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const users = await db.user.findMany({
    where: { disabled: false },
    select: {
      id: true,
      name: true,
      email: true,
      extension: { select: { number: true } },
    },
    orderBy: { name: "asc" },
  });

  const rows = users.map((u) => ({
    id: u.id,
    name: u.name ?? u.email,
    extension: u.extension?.number ?? null,
  }));

  return NextResponse.json({ rows });
}
