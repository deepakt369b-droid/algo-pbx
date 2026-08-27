"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Web } from "sip.js";
import type { Session } from "sip.js";
import type { CallState, AgentStatus } from "@/types";
import { extractCallQuality } from "@/lib/webrtc-stats";

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
  }, [sessionStatus]);

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
            primarySessionRef.current = null;
            setCallState("idle");
            setIncomingCallerId(null);
            setIsMuted(false);
            currentCallIdRef.current = null;
          } else if (ended === consultSessionRef.current) {
            consultSessionRef.current = null;
            setConsultState("idle");
          }
        },
        onCallHold: (holdSession, isHeld) => {
          if (holdSession === primarySessionRef.current) {
            setCallState(isHeld ? "held" : "active");
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
  }, [credentials, turnCredentials, runtimeConfig, patchServerStatus]);

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

  const toggleHold = useCallback(async () => {
    const manager = sessionManagerRef.current;
    const target = primarySessionRef.current;
    if (!manager || !target) return;
    // The actual callState flip happens in the onCallHold delegate above,
    // once Asterisk confirms the re-INVITE — not assumed optimistically
    // here, since a hold/unhold re-INVITE can be rejected.
    if (callState === "held") {
      await manager.unhold(target);
    } else if (callState === "active") {
      await manager.hold(target);
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
    // SessionManager.transfer(session, target): a string target means
    // blind transfer (plain REFER) — the public, documented equivalent of
    // the old private-`session.refer()` hack.
    const referTo = `sip:${destination}@${sipDomainRef.current}`;
    await manager.transfer(target, referTo);
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
      if (callState === "active") {
        try {
          await manager.hold(target); // onCallHold delegate flips callState to "held"
        } catch {
          // The hold re-INVITE was rejected — proceeding used to dial the
          // consult leg anyway, putting TWO live sessions on one shared
          // <audio> element (both audible at once). Abort instead and tell
          // the agent via the same surface the Dialpad uses for call errors.
          console.error("Hold failed — attended transfer aborted.");
          setDialError("Could not hold the current call — attended transfer aborted.");
          return;
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
    [callState]
  );

  const completeAttendedTransfer = useCallback(async () => {
    const manager = sessionManagerRef.current;
    const primary = primarySessionRef.current;
    const consult = consultSessionRef.current;
    if (!manager || !primary || !consult) return;
    // Session target -> attended transfer completion (REFER w/ Replaces),
    // per SessionManager.transfer()'s own documented behavior. A failure
    // here must NOT run the optimistic reset below — both sessions are
    // still alive, so rethrow and let the caller show the error while the
    // agent can retry or cancel.
    await manager.transfer(primary, consult);
    // Both legs end from the transferor's perspective once the transfer
    // completes; onCallHangup will fire for each and reset state, but
    // reset optimistically too so the UI doesn't wait on that round-trip.
    primarySessionRef.current = null;
    consultSessionRef.current = null;
    setCallState("idle");
    setConsultState("idle");
    setIncomingCallerId(null);
  }, []);

  const cancelAttendedTransfer = useCallback(async () => {
    const manager = sessionManagerRef.current;
    const primary = primarySessionRef.current;
    const consult = consultSessionRef.current;
    if (!manager) return;
    if (consult) {
      await manager.hangup(consult).catch(() => undefined);
      consultSessionRef.current = null;
      setConsultState("idle");
    }
    if (primary && callState === "held") {
      await manager.unhold(primary); // onCallHold delegate flips callState back to "active"
    }
  }, [callState]);

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
        callState,
        cancelAttendedTransfer,
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
