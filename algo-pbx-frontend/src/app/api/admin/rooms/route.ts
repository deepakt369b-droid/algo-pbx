import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/rooms — a Room is a named, persisted list of
// User.id's an admin wants to view together (call-center wallboard +
// WhatsApp/SMS activity, side by side). Deliberately NOT a tenancy
// mechanism: no other model gains a roomId column, no query anywhere else
// in the app is scoped by room. It's a saved filter, nothing more.
const CreateRoomSchema = z.object({
  name: z.string().min(1).max(100),
  memberUserIds: z.array(z.string()).max(200),
});

export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const rooms = await db.room.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ rooms });
}

export async function POST(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const parsed = CreateRoomSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const room = await db.room.create({
    data: {
      name: parsed.data.name,
      memberUserIds: parsed.data.memberUserIds,
      createdById: guard.session.user.id,
    },
  });
  return NextResponse.json({ room }, { status: 201 });
}
