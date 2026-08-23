import { unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { canAccessMailbox, parseVoicemailId } from "@/lib/voicemail-spool";

export const dynamic = "force-dynamic";

const CONTEXT = "default";

// DELETE /api/voicemail/[id] — genuinely destructive, UNLIKE Phase D's
// recording "hide" (which never deletes). The plan flagged this asymmetry
// explicitly for confirmation before building: raw voicemail wasn't named
// as a retained/compliance artifact the way call recordings were ("the
// voice recording will be on admin side also but the agent side deletion
// will not delete the recording" — said only about recordings). Proceeding
// with real deletion here matches that reading, but this is a judgment
// call, not a certainty — flagged again in LLM.md. If voicemail should
// actually behave like recordings (agent-hide, admin-retains), this route
// needs to change to a soft-hide model instead.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
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
  const wavPath = path.resolve(dir, `${parsed.msgBase}.wav`);
  const txtPath = path.resolve(dir, `${parsed.msgBase}.txt`);
  if (!wavPath.startsWith(dir + path.sep) || !txtPath.startsWith(dir + path.sep)) {
    return NextResponse.json({ error: "Invalid voicemail id" }, { status: 400 });
  }

  // Was `.catch(() => {})` on both — silently swallowed EROFS (the
  // /voicemail mount was previously read-only in docker-compose.yml,
  // fixed alongside this) and any other failure, then unconditionally
  // returned {ok:true}. The agent's UI would show the message vanish and
  // it would reappear on the next page load, with nothing anywhere
  // indicating the delete never actually happened. ENOENT (the file was
  // already gone — a legitimately harmless case, e.g. a retry after a
  // successful delete) is the one error still tolerated; everything else
  // is surfaced as a real failure.
  const results = await Promise.allSettled([unlink(wavPath), unlink(txtPath)]);
  const hardFailure = results.find(
    (r): r is PromiseRejectedResult => r.status === "rejected" && (r.reason as NodeJS.ErrnoException)?.code !== "ENOENT"
  );
  if (hardFailure) {
    return NextResponse.json(
      { error: `Failed to delete voicemail: ${(hardFailure.reason as Error).message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
