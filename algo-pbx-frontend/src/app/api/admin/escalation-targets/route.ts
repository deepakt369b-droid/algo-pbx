import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/escalation-targets — the full named list (active and
// inactive), for the admin management page. ADMIN-only (not
// requireStaffSession) to match this repo's existing convention that
// creating/managing standing configuration is stricter than day-to-day
// staff actions — same tier as POST /api/admin/users restricting who may
// create SUPERVISOR/ADMIN accounts.
export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const targets = await db.escalationTarget.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ targets });
}

const CreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    extension: z.string().regex(/^\d{3,6}$/).optional(),
    phoneE164: z.string().regex(/^\+\d{6,15}$/).optional(),
  })
  .refine((v) => v.extension || v.phoneE164, { message: "At least one of extension or phoneE164 is required." });

// POST /api/admin/escalation-targets — add a manager to the escalation
// list. Requires at least an extension or an external number (or both) —
// enforced here since Prisma has no CHECK-constraint DSL for it.
export async function POST(req: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const target = await db.escalationTarget.create({
    data: { ...parsed.data, createdById: guard.session.user.id },
  });
  return NextResponse.json({ target }, { status: 201 });
}
