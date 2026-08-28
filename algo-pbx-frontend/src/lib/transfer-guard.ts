// Single-port-Dinstar transfer guard.
//
// Confirmed live tonight via a real SIP trace: an agent on an active GSM
// call (bridged through the Dinstar trunk — currently a single active
// SIM/port) attempted a blind transfer to an external PSTN number. The
// dialplan handled the REFER by placing a SECOND outbound call through the
// SAME GSM trunk, from the already-bridged Dinstar leg, while the original
// call was still up. Dinstar correctly rejected the overlapping INVITE with
// 503 Service Unavailable (the port was already occupied) — there is no
// spare channel to dial back out with. That is a hardware limit, not a bug
// to route around: the correct fix is detecting this exact case and
// rejecting it with a clear, honest error BEFORE the REFER is ever sent,
// rather than letting it reach the Dinstar and surface a mysterious 503 to
// the agent.
//
// This is Option A (client-side rejection) from the fix plan — see
// sip-context.tsx's blindTransfer/startAttendedTransfer for where this is
// called, and call-controls.tsx for how the resulting error reaches the
// agent (the same thrown-Error -> transferError catch path already used for
// every other transfer failure in that component, not a new UI surface).
//
// Deliberately NOT paired with a server-side (dialplan) rejection in this
// pass — extensions.conf's from-agent-common already has no code path that
// distinguishes "REFER retargeting an existing Dinstar-bridged channel" from
// "a fresh outbound Dial() from an agent's own extension" without deep
// channel/bridge introspection (CHANNEL(peer), bridge membership) that is
// unverified against this specific Asterisk build. Rejecting before the
// REFER is even sent is strictly earlier and equally effective for the
// actual reported failure (blind transfer initiated from this softphone),
// and this repo has no Asterisk instance to build/verify dialplan-side
// channel inspection against. Revisit server-side enforcement if a
// non-softphone SIP client (a hardware phone) is ever given access to this
// trunk's agents, since it would bypass this guard entirely.

// Mirrors extensions.conf's [from-agent-local] internal-extension patterns
// EXACTLY (`_1XXX` / `_2XXX` — a literal 4-digit number starting with 1 or
// 2), not a broader "looks like an extension" heuristic. Those are the only
// two patterns that route to Dial(PJSIP/${EXTEN}) instead of out through
// dinstar-trunk; src/lib/pjsip-config.ts's `number` validation is looser
// (\d{3,6}) than what actually resolves as an internal destination today —
// that's a pre-existing gap in the dialplan itself, not something this
// guard should silently paper over by being more permissive than the
// dialplan actually is.
const INTERNAL_EXTENSION_PATTERN = /^[12]\d{3}$/;

/** True if `target` is a destination extensions.conf's [from-agent-local]
 * would route internally (Dial(PJSIP/...)) rather than out through the
 * Dinstar trunk. Never throws. */
export function isInternalExtension(target: string): boolean {
  return INTERNAL_EXTENSION_PATTERN.test(target.trim());
}

/** Where the CURRENT call's far-end leg is bridged through, as far as this
 * softphone can tell:
 *  - "trunk": the far end is reachable only via the Dinstar GSM trunk (an
 *    agent-dialed external/PSTN destination, or an inbound call that arrived
 *    via the queue from [from-dinstar] with an external caller id).
 *  - "internal": the far end is another internal extension (agent-to-agent,
 *    or an inbound direct-dial from one).
 *  - null: not yet known / no call in progress. */
export type CallOrigin = "trunk" | "internal" | null;

export interface TransferPermission {
  allowed: boolean;
  /** Non-null only when allowed is false — a clear, specific reason to
   * surface to the agent verbatim, never a generic "transfer failed". */
  reason: string | null;
}

/** Pure decision: may the agent's CURRENT call be transferred (blind or
 * attended) to `target`?
 *
 * Blocks exactly one case: the current call is Dinstar-trunk-originated AND
 * the transfer target is not a known internal extension — that combination
 * is what would make the dialplan place a second outbound Dial() through
 * the same, already-occupied GSM trunk. Internal-to-internal and
 * internal-to-external transfers (calls that never touched the Dinstar
 * trunk) are completely unaffected, as are trunk-to-internal transfers
 * (agent-to-agent/queue/voicemail), matching the requirement that this fix
 * must not touch any transfer path that doesn't go through the Dinstar
 * trunk.
 *
 * Fails OPEN (allowed: true) when `currentCallOrigin` is null/unknown —
 * same availability-over-blocking tradeoff this repo already makes
 * elsewhere (e.g. the DNC dialplan check failing open on an ODBC error):
 * a tracking gap in this client-side heuristic should not itself become a
 * new way to block a legitimate transfer. See sip-context.tsx for where
 * currentCallOrigin is set and its own confidence caveats. */
export function evaluateTransferPermission(params: {
  currentCallOrigin: CallOrigin;
  target: string;
}): TransferPermission {
  const { currentCallOrigin, target } = params;

  if (currentCallOrigin !== "trunk") {
    return { allowed: true, reason: null };
  }

  if (isInternalExtension(target)) {
    return { allowed: true, reason: null };
  }

  return {
    allowed: false,
    reason:
      "Can't transfer an active GSM call to another external number — this line only has one connection.",
  };
}
