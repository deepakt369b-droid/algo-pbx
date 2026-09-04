import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/rooms — a Room is a named, persisted list of
// User.id's an admin wants to view together (call-center wallboard +
// WhatsApp/SMS activity, side by side). Deliberately NOT a tenancy
// mechanism: no other model gains a roomId column, no query anywhere else
// in the app is scoped by room. It's a saved filter, nothing more.
const CreateRoomSchema = z.object({
  name: z.string().trim().min(1).max(100),
  memberUserIds: z.array(z.string()).max(200),
});

export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const rooms = await db.room.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ rooms });
}

export async function POST(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const parsed = CreateRoomSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  // Collapse internal whitespace too, not just leading/trailing (zod's
  // .trim() only handles the ends) — "Support  Team" and "Support Team"
  // should not both be creatable as if distinct.
  const name = parsed.data.name.replace(/\s+/g, " ");

  try {
    // No `tenantId` — force-injected at runtime by the TenantClient
    // extension (see src/lib/crm/activity.ts's comment on the same pattern).
    const room = await db.room.create({
      data: { name, memberUserIds: parsed.data.memberUserIds, createdById: guard.session.user.id } as unknown as Prisma.RoomUncheckedCreateInput,
    });
    return NextResponse.json({ room }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: `A room named "${name}" already exists.` }, { status: 409 });
    }
    throw err;
  }
}
