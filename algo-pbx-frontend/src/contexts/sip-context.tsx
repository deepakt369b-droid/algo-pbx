"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Web } from "sip.js";
import type { Session } from "sip.js";
import type { CallState, AgentStatus } from "@/types";
import { extractCallQuality } from "@/lib/webrtc-stats";
import { evaluateTransferPermission, isInternalExtension, type CallOrigin } from "@/lib/transfer-guard";
import { classifyTermination } from "@/lib/call-termination";
import { describeReferNotify, parseReferNotify } from "@/lib/refer-notify";

// Phase F rewrite: migrated off Web.SimpleUser onto sip.js's official
// Web.SessionManager. SimpleUser's own docblock says "it only handles a
// single concurrent session" — a hard blocker for attended transfer, which
// needs two (the original call + a consult call to the transfer target).
// SessionManager is purpose-built for multiple concurrent sessions
// (maxSimultaneousSessions defaults to 2 — exactly what attended transfer
// needs) and ships a first-class transfer(session, target) that does
// attended transfer (REFER w/ Replaces) when `target` is a Session and
// blind transfer (REFER) when it's a string — no manual SIP plumbing.
// This ALSO eliminates both of the old private-`session`-field hacks:
// incoming caller ID now comes from the public Session.remoteIdentity, and
// blind transfer now goes through the public SessionManager.transfer().
//
// Rejected alternative (per the original plan): a second parallel
// UserAgent for the consult call — would fight over the same WebSocket,
// registration, and media device. SessionManager avoids that by managing
// multiple sessions on ONE UserAgent/connection by design.

interface SIPContextType {
  isConnected: boolean;
  callState: CallState;
  isMuted: boolean;
  agentStatus: AgentStatus;
  incomingCallerId: string | null;
  dialError: string | null;
  /** Agent-facing explanation for a call that just ended abnormally — a
   * failed hold re-INVITE (see src/lib/call-termination.ts) or a
   * failed/unconfirmed transfer (see src/lib/refer-notify.ts). Rendered by
   * CallControls, including in its "idle" branch, so the explanation
   * survives the collapse back to "No active call" instead of vanishing
   * with the card that would have shown it. */
  callError: string | null;
  clearCallError: () => void;
  /** True when the browser's autoplay policy blocked remote audio
   * playback — see onCallAnswered's comment. The UI should render an
   * "unmute" affordance calling retryAudioPlayback when this is true. */
  audioBlocked: boolean;
  retryAudioPlayback: () => void;
  makeCall: (destination: string) => Promise<void>;
  answerCall: () => Promise<void>;
  hangupCall: () => Promise<void>;
  toggleMute: () => void;
  toggleHold: () => Promise<void>;
  sendDtmf: (digit: string) => Promise<void>;
  blindTransfer: (destination: string) => Promise<void>;
  setAgentStatus: (status: AgentStatus) => Promise<void>;
  // Attended transfer (Phase F) — a consult call runs alongside the
  // (held) primary call. consultState mirrors callState's shape but only
  // ever takes idle/calling/active — a consult call is never itself put on
  // hold or answered-from-ringing in this UI.
  consultState: "idle" | "calling" | "active";
  startAttendedTransfer: (destination: string) => Promise<void>;
  completeAttendedTransfer: () => Promise<void>;
  cancelAttendedTransfer: () => Promise<void>;
}

const SIPContext = createContext<SIPContextType | null>(null);

// Was `process.env.NEXT_PUBLIC_SIP_DOMAIN`/`NEXT_PUBLIC_SIP_WS_SERVER`
// read directly here — a real production bug: Next.js inlines
// NEXT_PUBLIC_ vars at BUILD time, but docker-compose.yml only ever
// supplied them at container RUNTIME, so both were always `undefined` in
// the actual built image and every agent's softphone silently fell back
// to `wss://algopbx.local:8089/ws`, a hostname that does not resolve. No
// agent could ever have registered. Fixed by fetching these from
// GET /api/config/public (a server-side route, which sees the real
// runtime env) instead of reading them as client-bundle constants — see
// that route's own header comment for the full story.
interface RuntimeConfig {
  sipDomain: string;
  sipWsServer: string;
}

interface SipCredentials {
  extension: string;
  secret: string;
}

interface TurnCredentials {
  username: string;
  credential: string;
  urls: string[];
}

export const SIPProvider = ({ children }: { children: React.ReactNode }) => {
  const { data: session, status: sessionStatus } = useSession();
  const sessionManagerRef = useRef<Web.SessionManager | null>(null);
  // Mirrors session.user.extension for use inside delegate callbacks and
  // helpers that must not depend on a possibly-stale closure over session.
  const extensionRef = useRef<string | null>(null);
  useEffect(() => {
    extensionRef.current = session?.user.extension ?? null;
  }, [session?.user.extension]);
  // Best-effort DB sync of the agent status (wallboard/queue views read
  // Extension.status). Fire-and-forget: a transient failure here is
  // corrected by the next explicit status change; never blocks the UI.
  const patchServerStatus = useCallback(async (status: AgentStatus) => {
    const ext = extensionRef.current;
    if (!ext) return;
    try {
      await fetch(`/api/extensions/${ext}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    } catch {
      // non-fatal — see comment above
    }
  }, []);
  // The agent's one "current call" as far as the UI is concerned (Dialpad/
  // CallControls). The consult call (attended transfer) is tracked
  // separately and never conflated with this one.
  const primarySessionRef = useRef<Session | null>(null);
  const consultSessionRef = useRef<Session | null>(null);
  // Single-port-Dinstar transfer guard (see src/lib/transfer-guard.ts's
  // header comment for the full incident writeup) — tracks whether the
  // CURRENT primary call's far end is only reachable through the Dinstar
  // GSM trunk, so blindTransfer/startAttendedTransfer can refuse to send a
  // REFER that the dialplan would otherwise turn into a second, doomed
  // outbound Dial() through the same already-occupied GSM port. Set
  // explicitly on both call directions (outbound in makeCall, inbound in
  // onCallReceived below) and cleared on hangup — never inferred lazily at
  // transfer time, since by then the only signal left is the (possibly
  // stale) remote identity.
  const primaryCallOriginRef = useRef<CallOrigin>(null);
  // Set for the duration of a hold/unhold re-INVITE or an attended-transfer
  // completion REFER against the PRIMARY session — read by onCallHangup to
  // tell an ordinary hangup apart from sip.js killing the session itself as
  // a side effect of one of those in-flight operations (see
  // src/lib/call-termination.ts's header for why that distinction matters
  // and why it can only be inferred this way, not read off sip.js's own
  // termination reason).
  //
  // NOT cleared in toggleHold's own finally (that used to be the whole
  // mechanism, and it was a bug): SessionManager.hold()/unhold() resolve the
  // instant the re-INVITE is SENT (sip.js's Session.invite() returns at
  // `this.dialog.invite(...)`, before any response), not when Asterisk
  // answers it. A finally keyed to that promise clears the flag long before
  // the 200 OK — or a 2xx whose SDP the browser can't apply — ever arrives,
  // so the exact failure this flag exists to catch (a hold re-INVITE that
  // silently kills the call) went undetected: onCallHangup ran with the flag
  // already false, classifyTermination saw an ordinary hangup, and the call
  // vanished with no explanation. Cleared instead by whichever of these
  // actually resolves the attempt: onCallHold firing (confirmed success),
  // onCallHangup reading it (confirmed failure), or the safety timeout in
  // toggleHold (SDK promise rejects with no delegate callback at all).
  const holdInFlightRef = useRef(false);
  const transferInFlightRef = useRef(false);
  // Registered by holdWithConfirmation() (below) while a caller needs to know
  // the REAL outcome of a hold/unhold attempt — not just that the SDK's
  // promise resolved, which happens the instant the re-INVITE is sent and
  // says nothing about whether Asterisk ever answered it (see
  // holdInFlightRef's comment for the full history). Resolved by onCallHold
  // firing for this session (confirmed success) or rejected by onCallHangup
  // firing for it first (the re-INVITE killed the call before answering it).
  const holdOutcomeWaiterRef = useRef<{
    session: Session;
    resolve: () => void;
    reject: (err: Error) => void;
  } | null>(null);
  // A useRef instead of document.getElementById("remote-audio") (the
  // previous approach) — fragile under Suspense/streaming rendering where
  // an effect can run before the element the id refers to has actually
  // committed to the DOM; a ref set by the JSX below is guaranteed
  // available by the time any effect that reads audioElementRef.current
  // runs.
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  // Separate element from audioElementRef (remote call audio) — before
  // this, an inbound call played NO sound at all anywhere in this app (no
  // `new Audio`/ringtone/Notification existed in the whole codebase), so
  // an agent not looking at the screen simply never knew a call arrived.
  // Kept as its own <audio loop> element rather than reusing
  // audioElementRef because the two need independent play/pause
  // lifecycles: the ringtone plays BEFORE a session exists to attach as
  // srcObject, and must stop the instant the call is answered/declined/
  // cancelled, none of which should touch the separate remote-audio path.
  const ringtoneElementRef = useRef<HTMLAudioElement | null>(null);

  const [credentials, setCredentials] = useState<SipCredentials | null>(null);
  const [turnCredentials, setTurnCredentials] = useState<TurnCredentials | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  // Mirrors runtimeConfig.sipDomain for the useCallback functions below
  // (makeCall/blindTransfer/startAttendedTransfer) that build `sip:`
  // URIs — a ref rather than a state read keeps those callbacks stable
  // without needing runtimeConfig in their own dependency arrays.
  const sipDomainRef = useRef("algopbx.local");
  // Set by the SessionManager effect's cleanup when a live call prevented
  // teardown — the next run of that effect skips rebuilding so the working
  // manager (and its live call) survive a late turnCredentials arrival.
  const skipRebuildRef = useRef(false);
  const [isConnected, setIsConnected] = useState(false);
  // Correlates client-captured WebRTC stats (src/lib/webrtc-stats.ts) back
  // to the call they belong to. sip.js's Session doesn't expose the raw
  // SIP Call-ID directly on the public API surface we use here, so this
  // is a locally-generated id, unique per call attempt — good enough to
  // group a call's own samples together, which is all the MCP
  // get_webrtc_call_quality tool and any future CDR join need.
  const currentCallIdRef = useRef<string | null>(null);
  const [callState, setCallState] = useState<CallState>("idle");
  const [consultState, setConsultState] = useState<"idle" | "calling" | "active">("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [agentStatus, setAgentStatusState] = useState<AgentStatus>("OFFLINE");
  const [incomingCallerId, setIncomingCallerId] = useState<string | null>(null);
  const [dialError, setDialError] = useState<string | null>(null);
  // Distinct from dialError: dialError is rendered by Dialpad (dial-time
  // failures — a call that never got established). callError is rendered
  // by CallControls, for a call that WAS established and then ended
  // abnormally (failed hold, failed/unconfirmed transfer) — mixing the two
  // previously meant the attended-transfer hold failure (see
  // startAttendedTransfer below) wrote to dialError and the agent, looking
  // at CallControls, never saw it.
  const [callError, setCallError] = useState<string | null>(null);
  const clearCallError = useCallback(() => setCallError(null), []);
  const [audioBlocked, setAudioBlocked] = useState(false);

  // Step 0: fetch the runtime SIP domain/WS server — unauthenticated,
  // fires immediately on mount rather than waiting on session status,
  // since this is public, non-secret config (see RuntimeConfig's comment
  // above and GET /api/config/public).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/public")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setRuntimeConfig({ sipDomain: data.sipDomain, sipWsServer: data.sipWsServer });
          sipDomainRef.current = data.sipDomain;
        }
      })
      .catch(() => {
        // Fall back to the same default the server route itself uses —
        // better than leaving the softphone permanently unable to start
        // if this one fetch fails for some transient reason.
        if (!cancelled) setRuntimeConfig({ sipDomain: "algopbx.local", sipWsServer: "wss://algopbx.local:8089/ws" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 1: once signed in, fetch this user's OWN SIP credentials from an
  // authenticated endpoint rather than reading a build-time env var (see
  // src/app/api/me/sip-credentials/route.ts's comment for the full history
  // — this predates Phase F and is unrelated to the SessionManager migration).
  useEffect(() => {
    if (sessionStatus !== "authenticated") {
      setCredentials(null);
      setTurnCredentials(null);
      return;
    }
    let cancelled = false;
    fetch("/api/me/sip-credentials")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        if (!cancelled) setCredentials({ extension: data.extension, secret: data.sipSecret });
      })
      .catch(() => {
        if (!cancelled) setCredentials(null);
      });
    // TURN credentials are fetched alongside, not blocking SIP
    // registration on them — see api/me/turn-credentials/route.ts. If this
    // fails (e.g. COTURN_AUTH_SECRET not configured yet), registration
    // still proceeds with host/srflx candidates only, same as before this
    // fix existed; it just loses the NAT-traversal fallback.
    fetch("/api/me/turn-credentials")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        if (!cancelled) setTurnCredentials({ username: data.username, credential: data.credential, urls: data.urls });
      })
      .catch(() => {
        if (!cancelled) setTurnCredentials(null);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the user's ID as well as the status, NOT status alone. All
    // tabs in a browser share one `authjs.session-token` cookie, and
    // sessionStatus stays "authenticated" straight through an account swap —
    // it only transitions on sign-out. Keyed on status alone this effect
    // never re-fired, so `credentials` (extension + plaintext sipSecret)
    // stayed on the PREVIOUS user's values and the SessionManager below kept
    // the old extension registered to Asterisk: that tab went on receiving
    // the old user's inbound calls and could originate from their extension,
    // with their SIP secret still readable in JS memory. Server-side ACLs
    // cannot see any of this — WebRTC registration is browser->Asterisk over
    // WSS directly. Including the ID makes an identity change refetch, which
    // changes `credentials`, which rebuilds the SessionManager in Step 2.
  }, [sessionStatus, session?.user?.id]);

  // Re-attach the primary call's remote audio to the shared <audio>
  // element after some OTHER session (the attended-transfer consult call)
  // has terminated and wiped it — see onCallHangup's consult-branch comment
  // for why SessionManager's shared-element design requires this.
  // manager.getRemoteMediaStream is the same public accessor sip.js's own
  // setupRemoteMedia uses internally (session-manager.js); undefined if the
  // session isn't Established, which the caller sites here already
  // guarantee. Declared here (ahead of the SessionManager-construction
  // effect below, which closes over it) rather than near the other call
  // actions further down, since a const referenced inside that effect's
  // own dependency array must already be initialized at render time.
  const reattachPrimaryAudio = useCallback((session: Session) => {
    const manager = sessionManagerRef.current;
    const audioEl = audioElementRef.current;
    if (!manager || !audioEl) return;
    const stream = manager.getRemoteMediaStream(session);
    if (!stream) return;
    audioEl.srcObject = stream;
    // Same autoplay-policy handling as onCallAnswered — reattaching
    // srcObject programmatically can hit the same Chrome block a fresh
    // inbound-call assignment does.
    audioEl
      .play()
      .then(() => setAudioBlocked(false))
      .catch(() => setAudioBlocked(true));
  }, []);

  // Step 2: once credentials are known, register the softphone under THIS
  // user's own extension via a SessionManager instance.
  useEffect(() => {
    if (!credentials || !runtimeConfig) return;
    // A late turnCredentials fetch used to tear down and rebuild the
    // SessionManager unconditionally — including MID-CALL: the live call's
    // media path died while callState stayed "active"/"held" with no
    // session behind it. If any session is live at cleanup time, we now
    // skip the rebuild entirely (the new ICE config simply applies on the
    // next natural reconnect/rebuild instead).
    if (skipRebuildRef.current) {
      skipRebuildRef.current = false;
      return;
    }
    const { extension, secret } = credentials;
    const { sipDomain, sipWsServer } = runtimeConfig;
    const audioElement = audioElementRef.current;

    // Was `{ audio: true, video: false }` — Chrome applies sane EC/NS/AGC
    // defaults for a bare `audio: true`, but that leaves no control over
    // AGC pumping (a real issue in a noisy shared call-center room) and no
    // device selection, so a headset-plus-webcam agent could silently
    // capture the wrong mic. Explicit is better than an implicit
    // per-browser default here.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    };

    if (!sipWsServer || !/^wss?:\/\//i.test(sipWsServer)) {
      // Defensive: a bad/empty WS URL used to throw synchronously inside
      // the sip.js Transport constructor and take the whole app down via
      // the React error boundary (white screen on every page, including
      // /login). Fail soft — the agent sees a disconnected softphone, not
      // a dead app.
      console.error("SIP: refusing to start — invalid WS server URL", sipWsServer);
      setIsConnected(false);
      return;
    }

    let manager: Web.SessionManager;
    try {
      manager = new Web.SessionManager(sipWsServer, {
      aor: `sip:${extension}@${sipDomain}`,
      media: {
        // SessionManagerMediaConstraints.audio/video are plain booleans —
        // they only toggle whether the SDP offer/answer includes that
        // media type at all, not the getUserMedia() constraints. The
        // actual per-track constraints (echoCancellation etc., below)
        // belong on sessionDescriptionHandlerFactoryOptions.constraints
        // instead, which is a real MediaStreamConstraints.
        constraints: { audio: true, video: false },
        // Same element for every managed session — at most one session is
        // ever actually producing audible audio at a time in this UI (the
        // primary call is held, and therefore SDP sendonly/silent, for the
        // whole duration a consult call is active), so sharing one element
        // doesn't create an audible conflict.
        remote: { audio: audioElement ?? undefined },
      },
      // Reconnection was previously entirely absent: a dropped WebSocket
      // (WiFi roam, ISP blip, laptop sleep — routine for an agent on
      // Indian consumer broadband) left the UI showing isConnected:true /
      // agentStatus:"AVAILABLE" forever, with the agent sitting in
      // support_queue as a bookable member while genuinely unreachable —
      // every inbound call offered to them rang into the void for the
      // full queue timeout. sip.js's SessionManager has built-in
      // reconnection; it was simply never configured.
      reconnectionAttempts: 30,
      reconnectionDelay: 4,
      userAgentOptions: {
        authorizationUsername: extension,
        authorizationPassword: secret,
        // Opt-in verbose sip.js logging (SDP, re-INVITE handling, session
        // state transitions) — off by default since it's noisy. Turn on
        // with NEXT_PUBLIC_SIP_DEBUG=1 to capture the exact failure
        // reason when a hold/transfer re-INVITE goes wrong in the field:
        // look for "Failed to handle answer in 2xx response to re-INVITE"
        // or "...without a session description" immediately followed by
        // "Session state changed to Terminated", which confirms sip.js
        // itself killed the session (see call-termination.ts's header).
        logLevel: process.env.NEXT_PUBLIC_SIP_DEBUG === "1" ? "debug" : "warn",
        transportOptions: {
          // CRITICAL: `server` MUST be repeated here. sip.js's
          // SessionManager only falls back to its `server` constructor
          // arg when `userAgentOptions.transportOptions` is UNSET — as
          // soon as this object exists (for keepAliveInterval below),
          // the constructor arg is ignored and the transport gets "",
          // throwing "Invalid WebSocket Server URL" and crashing the
          // whole app via the React error boundary. This is why the
          // agent softphone never connected.
          server: sipWsServer,
          // WebSocket keepalive — without this, some intermediate
          // proxies/NAT devices silently drop an idle WSS connection long
          // before either end notices, which is functionally identical to
          // the "no reconnection logic" bug above from the agent's
          // perspective (registered-but-unreachable) until the next
          // action attempt fails.
          keepAliveInterval: 30,
        },
        // sip.js's UserAgentOptions types this loosely as `object` (see
        // that field's own doc comment pointing implementers at the
        // concrete SessionDescriptionHandlerOptions shape) — it is NOT a
        // SessionManagerOptions-level field despite reading like one;
        // placing it there compiles under a loose structural match but
        // is never actually wired to the session description handler
        // sip.js builds. This is the one place it actually takes effect.
        sessionDescriptionHandlerFactoryOptions: {
          // Mandatory once TURN servers are present below — sip.js/webrtc's
          // default ICE gathering waits for the full candidate set,
          // including an allocation attempt to a TURN relay that may be
          // unreachable; without a bound on that, post-dial delay before
          // the INVITE is even sent can run into multiple seconds.
          iceGatheringTimeout: 2000,
          // The real getUserMedia() constraints (echoCancellation/
          // noiseSuppression/autoGainControl/channelCount/sampleRate) —
          // this, not the SessionManager-level media.constraints above
          // (which is just a boolean audio/video toggle), is what sip.js's
          // SessionDescriptionHandlerOptions actually accepts as
          // MediaStreamConstraints.
          constraints: { audio: audioConstraints, video: false } as MediaStreamConstraints,
          peerConnectionConfiguration: {
            iceServers: turnCredentials
              ? [
                  { urls: turnCredentials.urls.filter((u) => u.startsWith("stun:")) },
                  {
                    urls: turnCredentials.urls.filter((u) => u.startsWith("turn:") || u.startsWith("turns:")),
                    username: turnCredentials.username,
                    credential: turnCredentials.credential,
                  },
                ]
              : [],
            // "all" (not "relay") — TURN is a NAT-traversal FALLBACK, not
            // forced. Most agents on a normal connection succeed with
            // host/srflx candidates alone; "all" tries every candidate type
            // and uses whichever pair actually connects, so this fixes the
            // symmetric-NAT/restrictive-firewall failure case without
            // paying relay latency+bandwidth cost for everyone else.
            iceTransportPolicy: "all",
            bundlePolicy: "max-bundle",
            rtcpMuxPolicy: "require",
          },
        },
      },
      registererOptions: {
        // Re-REGISTER well inside Asterisk's own registration expiry so a
        // missed refresh (a brief network hiccup) doesn't drop the
        // registration before the next attempt.
        expires: 120,
      },
      delegate: {
        onServerConnect: () => {
          setIsConnected(true);
          manager.register().catch((err) => console.error("Re-register after reconnect failed:", err));
          // Sync the DB-backed status too — wallboard/queue views read
          // Extension.status, and a reconnect previously left them stale.
          patchServerStatus("AVAILABLE");
        },
        onServerDisconnect: () => {
          // The UI must show this honestly rather than staying on stale
          // "AVAILABLE" — see this block's header comment for why that
          // was a real production bug, not a cosmetic one.
          setIsConnected(false);
          setAgentStatusState("OFFLINE");
          patchServerStatus("OFFLINE");
        },
        onCallReceived: async (incoming) => {
          if (primarySessionRef.current) {
            // Call waiting is out of scope for this UI (there is exactly
            // one "current call" slot) — decline rather than silently
            // dropping the caller with no response at all.
            await manager.decline(incoming).catch(() => undefined);
            return;
          }
          primarySessionRef.current = incoming;
          setCallState("ringing");
          // Public API now (Session.remoteIdentity) — no more reaching into
          // a private field like the SimpleUser version had to.
          setIncomingCallerId(incoming.remoteIdentity.displayName || incoming.remoteIdentity.uri.toString());
          // Transfer guard: an inbound call whose caller-id user part looks
          // like an internal extension is another agent/extension dialing
          // directly (never touches the Dinstar trunk); anything else
          // (queue-distributed GSM calls always present the external
          // caller's own number here) is trunk-originated. Best-effort —
          // see transfer-guard.ts's CallOrigin doc comment for the fail-open
          // behavior if this is ever wrong.
          {
            const callerUser = incoming.remoteIdentity.uri.user ?? "";
            primaryCallOriginRef.current = isInternalExtension(callerUser) ? "internal" : "trunk";
          }
        },
        onCallAnswered: (answered) => {
          if (answered === primarySessionRef.current) {
            setCallState("active");
            currentCallIdRef.current = `${extension}-${Date.now()}`;
            // `<audio autoPlay>` alone is not reliable here: Chrome's
            // autoplay policy blocks playback on a programmatically-
            // assigned srcObject (which is exactly what sip.js's
            // SessionManager does internally) unless a recent user
            // gesture is on record. An agent-initiated outbound call has
            // one (they clicked Call); an inbound call answered via a
            // non-click path (e.g. auto-answer) may not — which
            // previously meant the AGENT could hear nothing on some
            // inbound calls while the caller heard them fine, with no
            // indication why. Explicitly (re)triggering play() here and
            // surfacing a manual "unmute" affordance on rejection turns a
            // silent failure into a recoverable one.
            audioElementRef.current
              ?.play()
              .then(() => setAudioBlocked(false))
              .catch(() => setAudioBlocked(true));
          } else if (answered === consultSessionRef.current) {
            setConsultState("active");
          }
        },
        onCallHangup: (ended) => {
          if (ended === primarySessionRef.current) {
            // Distinguish an ordinary hangup from sip.js having killed
            // THIS session itself as a side effect of an in-flight hold or
            // transfer re-INVITE/REFER (see call-termination.ts's header —
            // both land here through the same delegate, sip.js gives no
            // other signal). Read before clearing the refs below.
            const verdict = classifyTermination({
              holdInFlight: holdInFlightRef.current,
              transferInFlight: transferInFlightRef.current,
            });
            if (verdict.message) setCallError(verdict.message);
            // Resolve the in-flight flag here too, not just in onCallHold:
            // this is the "attempt failed" branch that flag exists to catch
            // in the first place (a hold re-INVITE Asterisk 2xx'd with an
            // SDP the browser couldn't apply, which sip.js reports as an
            // ordinary session termination, not a hold rejection).
            holdInFlightRef.current = false;
            if (holdOutcomeWaiterRef.current?.session === ended) {
              holdOutcomeWaiterRef.current.reject(new Error("call ended before the hold attempt was confirmed"));
              holdOutcomeWaiterRef.current = null;
            }
            primarySessionRef.current = null;
            primaryCallOriginRef.current = null;
            setCallState("idle");
            setIncomingCallerId(null);
            setIsMuted(false);
            currentCallIdRef.current = null;
          } else if (ended === consultSessionRef.current) {
            consultSessionRef.current = null;
            setConsultState("idle");
            // The consult leg just died (e.g. cancelAttendedTransfer's own
            // hangup, or the far end declining/hanging up on it) while the
            // primary call is still up. SessionManager shares ONE <audio>
            // element across every managed session (see the <audio
            // id="remote-audio"> below) and its cleanupMedia nulls that
            // element's srcObject whenever ANY session terminates — so
            // without this, the resumed primary call is left live but
            // silent. Re-attach on the next tick: this delegate fires
            // during sip.js's own cleanup, before it's necessarily safe to
            // read the primary session's media state back out.
            if (primarySessionRef.current) {
              const primary = primarySessionRef.current;
              setTimeout(() => reattachPrimaryAudio(primary), 0);
            }
          }
        },
        onCallHold: (holdSession, isHeld) => {
          if (holdSession === primarySessionRef.current) {
            setCallState(isHeld ? "held" : "active");
            // The hold/unhold re-INVITE Asterisk was asked about has now
            // actually been answered (this delegate only fires once a real
            // response comes back, unlike manager.hold()'s own promise —
            // see holdInFlightRef's comment). The attempt is resolved:
            // clear the flag so a LATER, unrelated hangup on this same call
            // isn't misread as a hold failure.
            holdInFlightRef.current = false;
            if (holdOutcomeWaiterRef.current?.session === holdSession) {
              holdOutcomeWaiterRef.current.resolve();
              holdOutcomeWaiterRef.current = null;
            }
          }
        },
      },
      });
    } catch (err) {
      console.error("SIP: SessionManager construction failed", err);
      setIsConnected(false);
      return;
    }

    sessionManagerRef.current = manager;

    manager
      .connect()
      .then(() => manager.register())
      .then(() => {
        setIsConnected(true);
        setAgentStatusState("AVAILABLE");
        void patchServerStatus("AVAILABLE");
      })
      .catch((err) => console.error("SIP connection/registration failed:", err));

    return () => {
      const liveSession = primarySessionRef.current ?? consultSessionRef.current;
      if (liveSession) {
        // Don't drop a live call because turnCredentials/runtimeConfig
        // changed underneath it — signal the next effect run to skip, and
        // leave the working manager (with its old ICE config) in place.
        skipRebuildRef.current = true;
        return;
      }
      manager.disconnect().catch(() => undefined);
      sessionManagerRef.current = null;
      primarySessionRef.current = null;
      primaryCallOriginRef.current = null;
      consultSessionRef.current = null;
      setIsConnected(false);
      // The teardown previously left callState/consultState/isMuted at
      // whatever they were — a stale "In call" with no session behind it.
      setCallState("idle");
      setConsultState("idle");
      setIsMuted(false);
      setIncomingCallerId(null);
    };
    // turnCredentials in deps: rebuilding the SessionManager once it
    // arrives (shortly after credentials, from a separate fetch) is what
    // actually gets the ICE servers into effect — accepted as a one-time
    // reconnect blip right after registration rather than a bigger
    // refactor to inject ICE servers into an already-constructed
    // SessionManager, which sip.js does not support post-construction.
    // patchServerStatus is a stable useCallback([]).
  }, [credentials, turnCredentials, runtimeConfig, patchServerStatus, reattachPrimaryAudio]);

  // Inbound-call ringtone + browser notification. Fires only on the
  // "ringing" transition (not on every callState change) so it plays
  // exactly once per incoming call and stops the instant the state moves
  // on — answered, declined, or the caller hung up before pickup.
  //
  // Autoplay note: unlike onCallAnswered's remote-audio play() (which has
  // a user gesture on record for an outbound call, or rides the incoming
  // INVITE's own event for inbound), a ringtone starting from a delegate
  // callback with no preceding click can still be blocked by the
  // browser's autoplay policy on some configurations — swallowed here
  // deliberately (silence-instead-of-a-console-error is the safe
  // fallback) since the browser Notification below is the redundant path
  // for exactly that case.
  useEffect(() => {
    const el = ringtoneElementRef.current;
    if (!el) return;
    if (callState === "ringing") {
      el.currentTime = 0;
      el.play().catch(() => undefined);
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        try {
          const n = new Notification("Incoming call", { body: incomingCallerId ?? "Unknown caller", tag: "algopbx-incoming-call" });
          n.onclick = () => window.focus();
        } catch {
          // Notification construction can throw in some embedded/insecure
          // contexts — never let a notification failure affect the call.
        }
      }
    } else {
      el.pause();
      el.currentTime = 0;
    }
    // incomingCallerId intentionally omitted: it's set in the same
    // onCallReceived delegate that transitions callState to "ringing", so
    // reading it here (rather than depending on it) avoids re-firing this
    // effect — and re-notifying — on an unrelated caller-id update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callState]);

  // WebRTC quality telemetry (src/lib/webrtc-stats.ts) — previously there
  // was no visibility anywhere into jitter/loss/RTT for a live call, so an
  // agent reporting "the audio was bad" was undiagnosable. Polls the
  // active session's underlying RTCPeerConnection every 5s and POSTs a
  // sample to /api/calls/quality, tagged with currentCallIdRef so samples
  // group by call.
  useEffect(() => {
    const interval = setInterval(() => {
      const session = primarySessionRef.current;
      const callId = currentCallIdRef.current;
      if (!session || !callId || callState !== "active") return;

      const pc = (session.sessionDescriptionHandler as unknown as { peerConnection?: RTCPeerConnection })
        ?.peerConnection;
      if (!pc) return;

      pc.getStats()
        .then((report) => {
          const sample = extractCallQuality(report);
          return fetch("/api/calls/quality", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callId, ...sample }),
          });
        })
        .catch(() => undefined);
    }, 5000);

    return () => clearInterval(interval);
  }, [callState]);

  const makeCall = useCallback(async (destination: string) => {
    const manager = sessionManagerRef.current;
    if (!manager || primarySessionRef.current) return;
    setDialError(null);

    // App-layer half of the two-layer Do Not Call enforcement (see
    // prisma/schema.prisma's DoNotCallEntry comment for the full picture —
    // this is UX/advisory only, the dialplan-level func_odbc check is what
    // actually blocks the call from a compliance standpoint). Fail open on
    // a network/parsing error rather than blocking legitimate calls because
    // this one guard endpoint hiccuped.
    try {
      const res = await fetch(`/api/dnc/check?number=${encodeURIComponent(destination)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.blocked) {
          setDialError(`${destination} is on the Do Not Call list — call blocked.`);
          return;
        }
      }
    } catch {
      // fail open — see comment above
    }

    setCallState("calling");
    const target = `sip:${destination}@${sipDomainRef.current}`;
    // Transfer guard: an agent-dialed destination matching an internal
    // extension pattern never reaches the Dinstar trunk; anything else
    // does (see extensions.conf's from-agent-* cascade — every non-internal
    // pattern eventually Dial()s PJSIP/${DIALNUM}@dinstar-trunk).
    primaryCallOriginRef.current = isInternalExtension(destination) ? "internal" : "trunk";
    try {
      const outgoing = await manager.call(target);
      primarySessionRef.current = outgoing;
      // callState transitions to "active" via onCallAnswered above, once
      // truly answered — SessionManager.call() itself only resolves when
      // the INVITE is sent, not when it's answered (an actual correctness
      // improvement over the previous SimpleUser code, which assumed
      // "active" the moment its own call() promise resolved).
    } catch (err) {
      console.error("Call failed:", err);
      setDialError("Call failed — see console for details.");
      setCallState("idle");
      primaryCallOriginRef.current = null;
    }
  }, []);

  const answerCall = useCallback(async () => {
    const manager = sessionManagerRef.current;
    const target = primarySessionRef.current;
    if (!manager || !target || callState !== "ringing") return;
    try {
      await manager.answer(target);
    } catch (err) {
      // The INVITE answer failed — the session is still ringing (or the
      // far end hung up); leave callState as-is rather than pretending
      // the call was answered, and surface the failure to the console.
      console.error("Answering the incoming call failed:", err);
      return;
    }
    setCallState("active");
    setIncomingCallerId(null);
  }, [callState]);

  const hangupCall = useCallback(async () => {
    const manager = sessionManagerRef.current;
    const target = primarySessionRef.current;
    if (!manager || !target) return;
    await manager.hangup(target);
    primarySessionRef.current = null;
    primaryCallOriginRef.current = null;
    setCallState("idle");
    setIncomingCallerId(null);
    setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    const manager = sessionManagerRef.current;
    const target = primarySessionRef.current;
    if (!manager || !target) return;
    if (isMuted) manager.unmute(target);
    else manager.mute(target);
    setIsMuted(!isMuted);
  }, [isMuted]);

  // Waits for the REAL outcome of a hold/unhold attempt, not the SDK
  // promise's premature resolution. Used by startAttendedTransfer and
  // cancelAttendedTransfer, which both had the same bug as toggleHold used
  // to: `await manager.hold(target)` returning the instant the re-INVITE is
  // sent let them proceed (dial the consult leg / assume "active" again)
  // before Asterisk had actually answered, so a hold failure there tore down
  // the primary mid-flight while the UI had already moved on.
  const holdWithConfirmation = useCallback((session: Session, wantHeld: boolean, timeoutMs = 8_000): Promise<void> => {
    const manager = sessionManagerRef.current;
    if (!manager) return Promise.reject(new Error("No active SIP session manager"));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (holdOutcomeWaiterRef.current?.session === session) holdOutcomeWaiterRef.current = null;
        reject(new Error("Timed out waiting for the hold to be confirmed."));
      }, timeoutMs);
      holdOutcomeWaiterRef.current = {
        session,
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      };
      const invite = wantHeld ? manager.hold(session) : manager.unhold(session);
      invite.catch((err) => {
        // The SDK rejected the promise directly — a pre-flight guard or
        // RequestPendingError, with no delegate callback coming at all.
        // Nothing else will ever settle this waiter, so do it here.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (holdOutcomeWaiterRef.current?.session === session) holdOutcomeWaiterRef.current = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }, []);

  const toggleHold = useCallback(async () => {
    const manager = sessionManagerRef.current;
    const target = primarySessionRef.current;
    if (!manager || !target) return;
    // The actual callState flip happens in the onCallHold delegate above,
    // once Asterisk confirms the re-INVITE — not assumed optimistically
    // here, since a hold/unhold re-INVITE can be rejected. A REJECTED
    // re-INVITE can't terminate the call (the Web SessionDescriptionHandler
    // has no rollbackDescription, so sip.js's rollbackOffer is a no-op) —
    // but an ACCEPTED one whose answer SDP the browser can't apply DOES
    // terminate it, from inside sip.js's own Session.invite(), and reports
    // through the same onCallHangup delegate as an ordinary hangup.
    //
    // holdInFlightRef is set here and deliberately NOT cleared in a finally
    // on this function — manager.hold()/unhold()'s own promise resolves the
    // instant the re-INVITE is sent, well before Asterisk answers it, so a
    // finally here would clear the flag before the failure this whole
    // mechanism exists to catch can even happen (see the ref's own comment
    // for the full history). onCallHold clears it on confirmed success;
    // onCallHangup clears it after reading the verdict on confirmed failure.
    // This effect's own catch only covers the SDK's promise rejecting
    // directly with no delegate callback at all (a pre-flight guard,
    // RequestPendingError) — in which case nothing else will ever clear the
    // flag, so it must be cleared here too.
    //
    // Safety timeout: if the re-INVITE is dropped somewhere (a lost
    // WebSocket frame, a gateway that never responds) neither onCallHold nor
    // onCallHangup ever fires, and without this the flag would stay stuck
    // "in flight" and mis-attribute the NEXT unrelated hangup on this call
    // as a hold failure.
    holdInFlightRef.current = true;
    const safetyTimer = setTimeout(() => {
      holdInFlightRef.current = false;
    }, 10_000);
    try {
      if (callState === "held") {
        await manager.unhold(target);
      } else if (callState === "active") {
        await manager.hold(target);
      }
    } catch (err) {
      console.error("Hold/unhold failed:", err);
      setCallError("Hold failed. If the call ended, the other party may still be on the line.");
      holdInFlightRef.current = false;
    } finally {
      clearTimeout(safetyTimer);
    }
  }, [callState]);

  const sendDtmf = useCallback(async (digit: string) => {
    const manager = sessionManagerRef.current;
    const target = primarySessionRef.current;
    if (!manager || !target) return;
    await manager.sendDTMF(target, digit);
  }, []);

  const blindTransfer = useCallback(async (destination: string) => {
    const manager = sessionManagerRef.current;
    const target = primarySessionRef.current;
    if (!manager || !target) return;
    // Single-port-Dinstar transfer guard — reject BEFORE sending the REFER
    // at all if this is a trunk call being sent to another external number
    // (see transfer-guard.ts's header comment). Thrown here so it surfaces
    // through the exact same catch/transferError path call-controls.tsx
    // already uses for every other transfer failure — no new UI surface.
    const permission = evaluateTransferPermission({ currentCallOrigin: primaryCallOriginRef.current, target: destination });
    if (!permission.allowed) {
      throw new Error(permission.reason ?? "Transfer not allowed.");
    }
    // SessionManager.transfer(session, target): a string target means
    // blind transfer (plain REFER) — the public, documented equivalent of
    // the old private-`session.refer()` hack.
    //
    // onNotify: Session.refer()/._refer() (session.js) resolves as soon as
    // the REFER hits the transport — never on the 202, and never on the
    // transfer-result NOTIFY that says whether the far end actually
    // accepted the referral. Without this, call-controls.tsx's
    // startTransfer closed the transfer form as if it had worked
    // regardless of the real outcome. For blind transfer the LOCAL leg
    // legitimately ends the moment Asterisk accepts the REFER (that's
    // BYE'd by Asterisk itself, not something this app resets) — so the
    // NOTIFY here is feedback only, surfaced via callError, not a gate on
    // any state reset.
    const referTo = `sip:${destination}@${sipDomainRef.current}`;
    await manager.transfer(target, referTo, {
      onNotify: (notification) => {
        const result = parseReferNotify(notification.request.body ?? "");
        if (result.progress === "failed") {
          setCallError(describeReferNotify(result));
        }
      },
    });
  }, []);

  // --- Attended transfer (Phase F) ---
  // Flow: hold the primary call -> dial the transfer target as a second
  // ("consult") session -> once the consult call is answered, either
  // complete (REFER w/ Replaces, merging the transferee into the consult
  // call and dropping the transferor) or cancel (hang up the consult call
  // and resume the primary).

  const startAttendedTransfer = useCallback(
    async (destination: string) => {
      const manager = sessionManagerRef.current;
      const target = primarySessionRef.current;
      if (!manager || !target || consultSessionRef.current) return;
      // Single-port-Dinstar transfer guard — attended transfer's consult
      // call IS itself a second outbound Dial() attempt (manager.call()
      // below, before any REFER is even in play), so this must be checked
      // here too, not just in blindTransfer. See transfer-guard.ts.
      const permission = evaluateTransferPermission({ currentCallOrigin: primaryCallOriginRef.current, target: destination });
      if (!permission.allowed) {
        throw new Error(permission.reason ?? "Transfer not allowed.");
      }
      if (callState === "active") {
        holdInFlightRef.current = true;
        try {
          // Waits for onCallHold to actually fire, not just for the
          // re-INVITE to be sent (see holdWithConfirmation's comment) — the
          // previous `await manager.hold(target)` here resolved immediately
          // and could not have aborted on a hold failure even though the
          // comment above claimed it did; the consult leg was dialed before
          // Asterisk had answered the hold attempt at all.
          await holdWithConfirmation(target, true); // onCallHold delegate flips callState to "held"
        } catch {
          // The hold re-INVITE was rejected, or it killed the call outright
          // — either way, proceeding would dial the consult leg with no
          // primary safely on hold (best case: two live sessions sharing one
          // <audio> element, both audible at once; worst case: the primary
          // is already gone). Abort instead and tell the agent via the same
          // surface the Dialpad uses for call errors.
          console.error("Hold failed — attended transfer aborted.");
          // CallControls, not Dialpad — this failure happens mid-call
          // (there IS an active call, that's the whole premise of a
          // transfer), so it belongs on the same card as the rest of
          // transfer/hold error handling. dialError is Dialpad's surface
          // for dial-TIME failures and previously this write there meant
          // the agent, looking at CallControls, could simply never see it.
          setCallError("Could not hold the current call — attended transfer aborted.");
          return;
        } finally {
          holdInFlightRef.current = false;
        }
      }
      setConsultState("calling");
      const referTo = `sip:${destination}@${sipDomainRef.current}`;
      try {
        const consult = await manager.call(referTo);
        consultSessionRef.current = consult;
        // consultState -> "active" via onCallAnswered once truly answered.
      } catch (err) {
        console.error("Attended transfer consult call failed:", err);
        setConsultState("idle");
        throw err; // caller surfaces it in the UI
      }
    },
    [callState, holdWithConfirmation]
  );

  // How long to wait for a transfer-result NOTIFY before giving up on
  // confirmation. Not a hard protocol timeout — just how long the UI keeps
  // both sessions "in progress" before telling the agent the outcome is
  // unconfirmed rather than silently hanging the Complete Transfer button
  // forever if Asterisk never sends one.
  const ATTENDED_TRANSFER_NOTIFY_TIMEOUT_MS = 15_000;

  const completeAttendedTransfer = useCallback(async () => {
    const manager = sessionManagerRef.current;
    const primary = primarySessionRef.current;
    const consult = consultSessionRef.current;
    if (!manager || !primary || !consult) return;
    // Session target -> attended transfer completion (REFER w/ Replaces).
    //
    // manager.transfer() -> Session.refer() -> Session._refer() resolves as
    // soon as the REFER hits the transport — NOT on the 202, and NEVER on
    // the transfer-result NOTIFY that actually says whether the far end
    // accepted the referral (see refer-notify.ts's header). The PREVIOUS
    // version of this function treated that early resolution as "the
    // transfer succeeded" and reset both sessions unconditionally — so a
    // REFER later rejected (4xx/5xx/6xx; the Dinstar single-port 503 case
    // from transfer-guard.ts's header is exactly this) still collapsed the
    // UI to idle with BOTH sip.js sessions alive and orphaned: hangupCall
    // early-returns on the now-null ref, a later far-end BYE fails the
    // identity check in onCallHangup, and onCallReceived believes the
    // agent is free for a new call while two real ones are still up.
    //
    // Fix: pass onNotify and gate the reset on parseReferNotify actually
    // reporting success. On failure, keep BOTH sessions intact — the agent
    // can retry Complete Transfer or press Cancel, same as any other
    // in-progress transfer state. transferInFlightRef marks the window so
    // onCallHangup's classifyTermination (see call-termination.ts) can
    // explain it correctly if the primary session dies for some OTHER
    // reason while this is pending.
    transferInFlightRef.current = true;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        transferInFlightRef.current = false;
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        finish();
        // Deliberately resolve, not reject: an unconfirmed outcome is not
        // the same claim as a confirmed failure, and rejecting here would
        // make call-controls.tsx show a harder "failed" message than is
        // actually known to be true. Both sessions are left exactly as
        // they are (still in the consult UI) so the agent can act on
        // whatever Asterisk reports next, or retry.
        setCallError("Transfer status unconfirmed — no response from the server in time. The call may or may not have transferred; check before assuming either way.");
        resolve();
      }, ATTENDED_TRANSFER_NOTIFY_TIMEOUT_MS);

      manager
        .transfer(primary, consult, {
          onNotify: (notification) => {
            if (settled) return;
            const result = parseReferNotify(notification.request.body ?? "");
            if (result.progress === "succeeded") {
              settled = true;
              clearTimeout(timeout);
              finish();
              // Both legs end from the transferor's perspective once the
              // transfer completes; onCallHangup will also fire for each
              // (its guards no-op harmlessly against the already-nulled
              // refs below), but reset here too so the UI doesn't wait on
              // that separate round-trip.
              primarySessionRef.current = null;
              consultSessionRef.current = null;
              setCallState("idle");
              setConsultState("idle");
              setIncomingCallerId(null);
              resolve();
            } else if (result.progress === "failed") {
              settled = true;
              clearTimeout(timeout);
              finish();
              const message = describeReferNotify(result);
              setCallError(message);
              reject(new Error(message));
            }
            // "pending" (1xx) — keep waiting for a final NOTIFY.
          },
        })
        .catch((err) => {
          // The REFER itself couldn't even be sent (e.g. invalid session
          // state) — no NOTIFY will ever arrive for this attempt.
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          finish();
          reject(err);
        });
    });
  }, []);

  const cancelAttendedTransfer = useCallback(async () => {
    const manager = sessionManagerRef.current;
    const primary = primarySessionRef.current;
    const consult = consultSessionRef.current;
    if (!manager) return;
    if (consult) {
      // manager.hangup(consult) below terminates the consult session, which
      // fires onCallHangup's consult branch — that branch already calls
      // reattachPrimaryAudio when the primary is still live, restoring the
      // shared <audio> element's srcObject after SessionManager's
      // cleanupMedia wipes it (see that branch's comment for the full
      // explanation). Nothing extra needed here for that.
      await manager.hangup(consult).catch(() => undefined);
      consultSessionRef.current = null;
      setConsultState("idle");
    }
    if (primary && callState === "held") {
      // Same reasoning as startAttendedTransfer: manager.unhold()'s own
      // promise resolves on send, not on Asterisk's answer, so a plain
      // `await manager.unhold(primary)` here could not actually confirm the
      // primary came back before this function returns. Errors are
      // swallowed deliberately (unlike the hold-before-transfer case, there
      // is no further action to abort here — the consult leg is already
      // torn down above, so this is best-effort resumption of the primary).
      holdInFlightRef.current = true;
      try {
        await holdWithConfirmation(primary, false); // onCallHold delegate flips callState back to "active"
      } catch (err) {
        console.error("Unhold after cancelling attended transfer failed:", err);
      } finally {
        holdInFlightRef.current = false;
      }
    }
  }, [callState, holdWithConfirmation]);

  const setAgentStatus = useCallback(
    async (status: AgentStatus) => {
      const previous = agentStatus;
      setAgentStatusState(status); // optimistic — revert below if the PATCH fails

      const extension = session?.user.extension;
      if (!extension) {
        // No Extension row linked to this user yet (provisioning gap, not a
        // bug) — nothing to persist to, so just keep the optimistic local
        // state. See LLM.md §7.
        console.warn("setAgentStatus: no extension on session, status not persisted");
        return;
      }

      try {
        const res = await fetch(`/api/extensions/${extension}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
      } catch (err) {
        console.error("Failed to persist agent status:", err);
        setAgentStatusState(previous);
        // Rethrow so the UI (AgentStatusSelector) can show the failure —
        // the optimistic revert alone made the click look accepted, then
        // silently undo itself with zero feedback.
        throw err;
      }
    },
    [agentStatus, session?.user.extension]
  );

  const retryAudioPlayback = useCallback(() => {
    audioElementRef.current
      ?.play()
      .then(() => setAudioBlocked(false))
      .catch(() => setAudioBlocked(true));
  }, []);

  return (
    <SIPContext.Provider
      value={{
        agentStatus,
        answerCall,
        audioBlocked,
        blindTransfer,
        callError,
        callState,
        cancelAttendedTransfer,
        clearCallError,
        completeAttendedTransfer,
        consultState,
        dialError,
        hangupCall,
        incomingCallerId,
        isConnected,
        isMuted,
        makeCall,
        retryAudioPlayback,
        sendDtmf,
        setAgentStatus,
        startAttendedTransfer,
        toggleHold,
        toggleMute,
      }}
    >
      {children}
      <audio id="remote-audio" ref={audioElementRef} autoPlay playsInline />
      {/* ringtone.wav supplied by the operator (2026-08-27) — see
          public/sounds/README.md for provenance. Gitignored, not in git
          history; a missing/404 src fails play() silently (caught above)
          rather than crashing, which is what happened before this file
          existed. */}
      <audio id="ringtone" ref={ringtoneElementRef} loop preload="auto" src="/sounds/ringtone.wav" />
    </SIPContext.Provider>
  );
};

export const useSIP = () => {
  const context = useContext(SIPContext);
  if (!context) throw new Error("useSIP must be used within a SIPProvider");
  return context;
};
