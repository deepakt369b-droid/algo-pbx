import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canAccessMailbox, parseVoicemailMessageMetadata } from "@/lib/voicemail-spool";

export const dynamic = "force-dynamic";

// Asterisk's realtime-config context (voicemail.conf's [default]) — matches
// pbx_configs/extensions.conf's Voicemail(${VMBOX}@default,...) calls.
const CONTEXT = "default";
const SAFE_MAILBOX = /^\d{3,6}$/;

// GET /api/voicemail?mailbox=1001 — Phase E listing.
//   - AGENT: `mailbox` is ignored if present; always their own extension.
//     404s (not 403) if they have none linked, matching
//     GET /api/me/sip-credentials's treatment of the same situation.
//   - Staff: `mailbox` is required (there's no cheap "list every mailbox"
//     query without walking the whole spool tree, which isn't worth it for
//     a first cut — a supervisor knows which agent's mailbox they want to
//     check).
export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const isStaff = session.user.role === "ADMIN" || session.user.role === "SUPERVISOR";
  const requestedMailbox = req.nextUrl.searchParams.get("mailbox");
  const mailbox = isStaff ? requestedMailbox : session.user.extension;

  if (!mailbox) {
    return isStaff
      ? NextResponse.json({ error: "Missing ?mailbox=" }, { status: 400 })
      : NextResponse.json({ error: "No extension linked to this account" }, { status: 404 });
  }
  if (!SAFE_MAILBOX.test(mailbox)) {
    return NextResponse.json({ error: "Invalid mailbox" }, { status: 400 });
  }
  if (!canAccessMailbox({ role: session.user.role, callerExtension: session.user.extension, mailbox })) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dir = path.resolve(process.env.VOICEMAIL_DIR || "/voicemail", CONTEXT, mailbox, "INBOX");

  // Own-mailbox seen-state only — mirrors GET /api/me/missed-calls's
  // User.missedCallsSeenAt marker, but for voicemail. A staff member
  // browsing someone else's mailbox via ?mailbox= isn't "the agent who
  // owns this inbox", so lastSeenAt is deliberately omitted (null) for
  // that case rather than reporting the staff viewer's own unrelated
  // seen-timestamp.
  const lastSeenAt = isStaff
    ? null
    : (await db.user.findUnique({ where: { id: session.user.id }, select: { voicemailSeenAt: true } }))
        ?.voicemailSeenAt ?? null;

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // No INBOX directory yet just means no messages, not an error — a
    // brand-new mailbox has no spool folder until its first message.
    return NextResponse.json({ messages: [], lastSeenAt });
  }

  const txtFiles = files.filter((f) => f.endsWith(".txt")).sort();
  const messages = await Promise.all(
    txtFiles.map(async (txtFile) => {
      const base = txtFile.replace(/\.txt$/, "");
      const metadata = await readFile(path.join(dir, txtFile), "utf8")
        .then(parseVoicemailMessageMetadata)
        .catch(() => ({ callerId: null, origtime: null, durationSec: null, context: null }));
      return {
        id: `${mailbox}-${base}`,
        ...metadata,
        audioUrl: `/api/voicemail/${mailbox}-${base}/audio`,
      };
    })
  );

  return NextResponse.json({ messages, lastSeenAt });
}

// Marks the agent's own voicemail inbox as viewed — same lightweight
// same-route-POST pattern as POST /api/me/missed-calls. Always the
// session user's own extension/mailbox; there is no ?mailbox= override
// here, matching how the GET handler ignores it for AGENT sessions too.
export async function POST() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  await db.user.update({ where: { id: guard.session.user.id }, data: { voicemailSeenAt: new Date() } });
  return NextResponse.json({ ok: true });
}
