import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canAccessRecording } from "@/lib/recording-access";

export const dynamic = "force-dynamic";

// Recordings are never served from public/ or any static mount — they're
// sensitive call audio, so every byte transits through this authenticated
// route. Phase D: any signed-in user may reach this route now (not
// staff-only, as it was in the foundation phase) — access is instead
// decided per-recording by src/lib/recording-access.ts's
// canAccessRecording(), the SAME function GET /api/recordings uses for
// listing, so a hidden recording is unreachable by direct URL, not merely
// absent from a list (the property the original design called critical).
const SAFE_UNIQUEID = /^[A-Za-z0-9._-]+$/;

export async function GET(req: NextRequest, { params }: { params: { uniqueid: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const { uniqueid } = params;
  if (!SAFE_UNIQUEID.test(uniqueid)) {
    return NextResponse.json({ error: "Invalid recording id" }, { status: 400 });
  }

  // If there's no CDR row at all, cdrAgentExtension is null, which the
  // access function treats as "no one owns this" for an AGENT — staff
  // still pass via the role check regardless. Same reasoning applies if a
  // CDR exists but no Recording row has been created for it yet (e.g. the
  // call never actually produced a recording): hiddenFromAgentAt is null,
  // and the existsSync() check below is the real gate in that case, since
  // there's no file to stream either way.
  const cdr = await db.callDetailRecord.findUnique({
    where: { uniqueId: uniqueid },
    select: { id: true, agentExtension: true },
  });
  const recording = cdr ? await db.recording.findFirst({ where: { cdrId: cdr.id } }) : null;

  const allowed = canAccessRecording({
    role: session.user.role,
    callerExtension: session.user.extension,
    cdrAgentExtension: cdr?.agentExtension ?? null,
    hiddenFromAgentAt: recording?.hiddenFromAgentAt ?? null,
  });
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dir = path.resolve(process.env.RECORDINGS_DIR || "/recordings");
  const filePath = path.resolve(dir, `${uniqueid}.wav`);

  // Defense in depth: the regex above already forbids `/` and `..`, so
  // filePath cannot escape dir — but a resolved-path check costs nothing
  // and catches this invariant breaking under some future refactor.
  if (!filePath.startsWith(dir + path.sep)) {
    return NextResponse.json({ error: "Invalid recording id" }, { status: 400 });
  }

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "Recording not found" }, { status: 404 });
  }

  const stat = statSync(filePath);
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(stat.size),
      "Content-Disposition": `inline; filename="${uniqueid}.wav"`,
      // Never cache call recordings in a shared/browser cache.
      "Cache-Control": "private, no-store",
    },
  });
}
