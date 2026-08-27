import type { AmiClient, AmiEvent } from "@/lib/ami-client";

// Manager escalation (Loop C1). The actual transfer to the manager is an
// ordinary blindTransfer() SIP REFER — no new call-control primitive.
// Outcome detection is a SEPARATE, parallel AMI observation, because a
// REFER-driven transfer leg carries no ActionID for sendAndCollect() to
// correlate against; it has to be picked out of the general event stream
// by channel name instead.

export type EscalationOutcome = "ANSWERED" | "BUSY" | "NO_ANSWER" | "FAILED" | "UNKNOWN";

// Asterisk's DialEnd event carries DialStatus with these documented
// values (docs.asterisk.org/.../AMI_Events/DialEnd/) — same "probable, not
// proven against a live instance" confidence tier as every other AMI field
// mapping in this codebase (see queue-status.ts's own header comment for
// the established precedent of flagging this honestly rather than
// asserting false confidence).
export function classifyDialEnd(dialStatus: string | undefined): EscalationOutcome {
  switch (dialStatus) {
    case "ANSWER":
      return "ANSWERED";
    case "BUSY":
      return "BUSY";
    case "NOANSWER":
    case "CANCEL":
      return "NO_ANSWER";
    case "CONGESTION":
    case "CHANUNAVAIL":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

/** Watches for the DialEnd event belonging to a dial toward `extension`
 * (matched by channel prefix, same PJSIP/<ext>- convention queue-status.ts's
 * extensionFromInterface() already relies on) and classifies its outcome.
 * Resolves "UNKNOWN" (not a rejection) on timeout — treated by callers as
 * "no answer", since a manager-escalation attempt that never got a DialEnd
 * within a generous window is functionally the same as one that rang out. */
export async function watchEscalationOutcome(
  ami: AmiClient,
  extension: string,
  timeoutMs = 20000
): Promise<EscalationOutcome> {
  const event = await ami.waitForEvent((e: AmiEvent) => {
    if (e.Event !== "DialEnd") return false;
    const dest = e.DestChannel ?? e.Channel ?? "";
    return dest.startsWith(`PJSIP/${extension}-`);
  }, timeoutMs);
  if (!event) return "UNKNOWN";
  return classifyDialEnd(event.DialStatus);
}
