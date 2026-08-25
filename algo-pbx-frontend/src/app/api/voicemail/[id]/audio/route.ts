import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { canAccessMailbox, parseVoicemailId } from "@/lib/voicemail-spool";

export const dynamic = "force-dynamic";

const CONTEXT = "default";

// GET /api/voicemail/[id]/audio — streams a message's .wav, same
// authenticated-route-only principle as call recordings (never public/ or
// a static mount).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const parsed = parseVoicemailId(params.id);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid voicemail id" }, { status: 400 });
  }
  if (!canAccessMailbox({ role: session.user.role, callerExtension: session.user.extension, mailbox: parsed.mailbox })) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dir = path.resolve(process.env.VOICEMAIL_DIR || "/voicemail", CONTEXT, parsed.mailbox, "INBOX");
  const filePath = path.resolve(dir, `${parsed.msgBase}.wav`);
  if (!filePath.startsWith(dir + path.sep)) {
    return NextResponse.json({ error: "Invalid voicemail id" }, { status: 400 });
  }
  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "Voicemail message not found" }, { status: 404 });
  }

  const stat = statSync(filePath);
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, no-store",
    },
  });
}
