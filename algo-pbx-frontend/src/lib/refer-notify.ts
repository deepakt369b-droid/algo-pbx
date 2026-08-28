// Parses the sipfrag body of an in-dialog NOTIFY sent in response to a
// REFER, per RFC 3515/3265 ("message/sipfrag" bodies carrying a line like
// "SIP/2.0 200 OK").
//
// Why this exists: SessionManager.transfer() -> Session.refer() ->
// Session._refer() (node_modules/sip.js/lib/api/session.js) resolves its
// promise as soon as the REFER request is handed to the transport — NOT on
// the 202 Accepted, and NEVER on the transfer-result NOTIFY that actually
// says whether the far end accepted the referral. Before this, this
// codebase passed no onNotify/requestDelegate at all, so
// completeAttendedTransfer had zero signal about outcome and reset the UI
// to "idle" unconditionally the instant refer() resolved — including when
// the REFER was later rejected (4xx/5xx/6xx), which is exactly the
// Dinstar single-port 503 case documented in transfer-guard.ts's header
// (an attended transfer of a GSM-trunk call still overlaps the same
// occupied port the REFER targets). That left both sip.js sessions alive
// and orphaned while the UI already claimed "no active call".
//
// Consumed by sip-context.tsx's completeAttendedTransfer/blindTransfer via
// SessionManager.transfer(session, target, { onNotify }).
export type ReferProgress = "pending" | "succeeded" | "failed";

export type ReferNotifyResult = {
  progress: ReferProgress;
  /** The status code from the sipfrag's status line, or null if the body
   * couldn't be parsed (e.g. empty, or not a sipfrag at all). */
  statusCode: number | null;
  /** The reason phrase from the same status line, or null. */
  reason: string | null;
};

// "SIP/2.0 200 OK" — status line only; the rest of a sipfrag (if present)
// is headers this call site has no use for. Matches CR, LF or CRLF after
// the reason phrase (or end of string).
const SIPFRAG_STATUS_LINE = /^SIP\/2\.0\s+(\d{3})\s*(.*?)\s*(?:\r?\n|$)/;

/** Never returns "succeeded" unless the body unambiguously says 2xx — an
 * unparseable or missing body must never be read as transfer success. */
export function parseReferNotify(body: string): ReferNotifyResult {
  const match = SIPFRAG_STATUS_LINE.exec(body.trim());
  if (!match) {
    return { progress: "pending", statusCode: null, reason: null };
  }
  const statusCode = Number.parseInt(match[1], 10);
  const reason = match[2] || null;
  if (statusCode >= 100 && statusCode < 200) {
    return { progress: "pending", statusCode, reason };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return { progress: "succeeded", statusCode, reason };
  }
  if (statusCode >= 300 && statusCode < 700) {
    return { progress: "failed", statusCode, reason };
  }
  // Outside any valid SIP status-code range — treat as unparseable rather
  // than guessing.
  return { progress: "pending", statusCode: null, reason: null };
}

/** Agent-facing one-liner for a failed/pending transfer, for CallControls'
 * callError slot. */
export function describeReferNotify(result: ReferNotifyResult): string {
  if (result.progress === "failed") {
    const code = result.statusCode ?? "unknown";
    const reason = result.reason ? `: ${result.reason}` : "";
    return `Transfer rejected (${code}${reason}).`;
  }
  return "Transfer status unconfirmed.";
}
