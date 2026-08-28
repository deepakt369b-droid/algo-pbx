// Classifies why a sip.js session just terminated, for
// sip-context.tsx's onCallHangup delegate.
//
// There is no "ended" CallState in this app (src/types/index.ts) — the
// "call finished"-looking card IS callState === "idle" (see
// call-controls.tsx's "No active call" branch). Historically onCallHangup
// treated every termination identically: null the session ref, go idle,
// done. That is correct for an ordinary hangup, but sip.js's own
// SessionManager reports a session it killed ITSELF — from inside
// Session.invite()'s ackAndBye(400)/ackAndBye(488) paths, when a hold or
// attended-transfer-consult re-INVITE gets a 2xx the browser can't turn
// into a working answer — through the exact same onCallHangup delegate
// (see node_modules/sip.js/lib/platform/web/session-manager/
// session-manager.js's Terminating/Terminated case, which falls through to
// one onCallHangup call for both). From the agent's chair that reads as
// "the call just ended", while the far end (Asterisk, and whoever it's
// bridged to) is still up — collapsed here, live there.
//
// The leg really is gone in this case — the Web SessionDescriptionHandler
// implements no rollbackDescription, so a REJECTED re-INVITE can't
// terminate the call (rollbackOffer is a no-op); only an ACCEPTED one
// whose answer SDP fails locally can, and once that happens there is
// nothing left to rescue. So resetState is always true today. What this
// function buys is not recoverability, it's honesty: telling the agent
// WHY the call just ended instead of leaving Cause A silent (toggleHold
// had no try/catch and call-controls.tsx's onClick had no .catch, so
// previously this failure was an unhandled promise rejection with zero UI
// feedback).
//
// resetState stays part of the return value (rather than this just being
// a message-lookup function) so a future sip.js version able to
// distinguish "re-INVITE rejected, session survives" from "session truly
// terminated" can flip it without changing any call site.
export type TerminationContext = {
  /** A hold/unhold re-INVITE (SessionManager.hold/unhold -> Session.invite)
   * was in flight against THIS session when it terminated. */
  holdInFlight: boolean;
  /** An attended-transfer completion REFER (SessionManager.transfer) was
   * in flight against THIS session when it terminated. Blind transfer is
   * deliberately NOT included here — for blind transfer the local leg
   * legitimately ends the moment Asterisk accepts the REFER, so that
   * termination needs no special-cased message. */
  transferInFlight: boolean;
};

export type TerminationVerdict = {
  /** Whether the caller should proceed with its normal "session ended"
   * reset (null the ref, callState -> idle, etc). Always true in the
   * current sip.js version — see the file header. */
  resetState: boolean;
  /** Agent-facing explanation to surface (e.g. in CallControls' callError
   * slot), or null for an ordinary hangup with nothing more to say. */
  message: string | null;
};

/** Precedence when both flags are somehow set (attended transfer holds the
 * primary before dialing the consult leg, so in principle a hold failure
 * and a transfer-completion failure could race): transfer wins, since
 * completeAttendedTransfer is the more consequential, agent-initiated
 * action in flight — a stale hold failure message would be misleading if
 * what actually just happened was a failed transfer completion. */
export function classifyTermination(ctx: TerminationContext): TerminationVerdict {
  if (ctx.transferInFlight) {
    return {
      resetState: true,
      message:
        "The transfer could not be completed and the call has ended. The other party may still be on the line — check before assuming they hung up.",
    };
  }
  if (ctx.holdInFlight) {
    return {
      resetState: true,
      message: "Holding this call failed and it has ended on your side. The other party may still be connected.",
    };
  }
  return { resetState: true, message: null };
}
