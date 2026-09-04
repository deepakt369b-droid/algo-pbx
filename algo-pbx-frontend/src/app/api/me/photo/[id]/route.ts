import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { resolvePhotoPath } from "@/lib/agent-photo";

export const dynamic = "force-dynamic";

// GET /api/me/photo/[id] — [id] is the User.id whose photo to serve, not
// a filename (the actual on-disk filename is looked up server-side from
// User.photoPath, never accepted from the client — same principle as
// GET /api/recordings/[uniqueid]: the caller names a resource, the
// server decides which file that maps to). Visible to: the user
// themselves, and ADMIN/SUPERVISOR — never another agent, per the plan's
// visibility rule for this data.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const isSelf = guard.session.user.id === params.id;
  const isStaff = guard.session.user.role === "ADMIN" || guard.session.user.role === "SUPERVISOR";
  if (!isSelf && !isStaff) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const user = await guard.db.user.findUnique({ where: { id: params.id }, select: { photoPath: true } });
  if (!user?.photoPath) {
    return NextResponse.json({ error: "No photo on file" }, { status: 404 });
  }

  let filePath: string;
  try {
    filePath = resolvePhotoPath(user.photoPath);
  } catch {
    return NextResponse.json({ error: "No photo on file" }, { status: 404 });
  }

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "No photo on file" }, { status: 404 });
  }

  const stat = statSync(filePath);
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, no-store",
    },
  });
}
