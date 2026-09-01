import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/contact-ownership — Feature B5's manager view: the
// unassigned pool (Contact.ownerId: null, most-recent-activity first) and
// per-agent contact counts. Deliberately NOT under /api/admin/contacts —
// that surface belongs to a separate, parallel agent working the same
// round (see this session's ownership split); this is a new, narrowly-
// scoped read for the ownership picture specifically, reusing GET
// /api/admin/users (already exists) for the staff list rather than
// reaching into that other agent's files for anything.
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const [unassigned, counts] = await Promise.all([
    db.contact.findMany({
      where: { ownerId: null },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, numberE164: true, displayName: true, company: true, updatedAt: true },
    }),
    db.contact.groupBy({
      by: ["ownerId"],
      where: { ownerId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const ownerIds = counts.map((c) => c.ownerId).filter((id): id is string => id !== null);
  const owners = ownerIds.length
    ? await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true, disabled: true } })
    : [];
  const ownersById = new Map(owners.map((o) => [o.id, o]));

  const perAgentCounts = counts
    .map((c) => ({
      owner: c.ownerId ? (ownersById.get(c.ownerId) ?? { id: c.ownerId, name: "(deleted user)", email: "", disabled: true }) : null,
      contactCount: c._count._all,
    }))
    .sort((a, b) => b.contactCount - a.contactCount);

  return NextResponse.json({ unassigned, perAgentCounts });
}
