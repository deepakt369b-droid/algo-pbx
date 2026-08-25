// Parses Asterisk's voicemail message sidecar metadata (the `.txt` file
// that accompanies each `msgNNNN.wav` under
// /var/spool/asterisk/voicemail/<context>/<mailbox>/INBOX/). Pure text
// parsing, no filesystem access here — src/app/api/voicemail/route.ts does
// the directory listing and calls this per file.
//
// ⚠️ Confidence: MEDIUM on the exact key set/format below — based on
// Asterisk's long-documented convention (INI-style `key=value` under a
// `[message]` header), not verified against a live-generated file in this
// environment. Parsing is deliberately lenient (unknown/missing keys are
// just absent from the result, not an error) so a field-name drift across
// Asterisk versions degrades gracefully instead of breaking the whole list.

export interface VoicemailMessageMetadata {
  callerId: string | null;
  origtime: number | null; // unix seconds
  durationSec: number | null;
  context: string | null;
}

export function parseVoicemailMessageMetadata(txtContent: string): VoicemailMessageMetadata {
  const fields: Record<string, string> = {};
  for (const line of txtContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("[")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    fields[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }

  const origtime = fields.origtime ? Number(fields.origtime) : NaN;
  const duration = fields.duration ? Number(fields.duration) : NaN;

  return {
    callerId: fields.callerid || null,
    origtime: Number.isFinite(origtime) ? origtime : null,
    durationSec: Number.isFinite(duration) ? duration : null,
    context: fields.context || null,
  };
}

// Mailbox-level access check, used by both GET /api/voicemail (listing) and
// GET /api/voicemail/[id]/audio + DELETE /api/voicemail/[id] — same
// single-source-of-truth rationale as src/lib/recording-access.ts's
// canAccessRecording(), just simpler: a voicemail mailbox has no "hidden"
// concept, only ownership.
// Splits the `<mailbox>-<msgBase>` id used in /api/voicemail/[id] routes
// (e.g. "1001-msg0000") back into its parts, validating both strictly
// against Asterisk's own naming conventions — a mailbox is 3-6 digits (same
// rule pjsip-config.ts/dnc use elsewhere), and a spool message file base is
// always "msg" + digits. Returns null for anything that doesn't match,
// rather than throwing — callers treat that as "invalid id", a 400/404, not
// a server error.
const VOICEMAIL_ID = /^(\d{3,6})-(msg\d+)$/;

export function parseVoicemailId(id: string): { mailbox: string; msgBase: string } | null {
  const match = VOICEMAIL_ID.exec(id);
  if (!match) return null;
  return { mailbox: match[1], msgBase: match[2] };
}

export function canAccessMailbox(input: {
  role: "AGENT" | "SUPERVISOR" | "ADMIN";
  callerExtension: string | null;
  mailbox: string;
}): boolean {
  if (input.role === "ADMIN" || input.role === "SUPERVISOR") return true;
  return input.callerExtension !== null && input.callerExtension === input.mailbox;
}
