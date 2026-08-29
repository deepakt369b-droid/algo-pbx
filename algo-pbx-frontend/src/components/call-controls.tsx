"use client";

import { useState } from "react";
import { Mic, MicOff, Pause, Play, PhoneOff, PhoneForwarded, PhoneIncoming, Users, VolumeX } from "lucide-react";
import { useSIP } from "@/contexts/sip-context";
import { EscalationPicker } from "@/components/escalation-picker";

export function CallControls() {
  const {
    callState,
    isMuted,
    incomingCallerId,
    answerCall,
    hangupCall,
    declineCall,
    toggleMute,
    toggleHold,
    blindTransfer,
    consultState,
    startAttendedTransfer,
    completeAttendedTransfer,
    cancelAttendedTransfer,
    audioBlocked,
    retryAudioPlayback,
    callError,
    clearCallError,
  } = useSIP();
  const [transferTarget, setTransferTarget] = useState("");
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferMode, setTransferMode] = useState<"blind" | "attended" | "conference">("blind");
  const [conferenceStatus, setConferenceStatus] = useState<string | null>(null);
  // Transfer/conference actions used to fail silently — blind transfer was
  // fire-and-forget and attended-start only console.error'd. Any action
  // failure now surfaces here.
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);

  if (callState === "idle") {
    return (
      <div className="glass-card flex w-full max-w-xs flex-col items-center gap-2 p-6 text-center">
        <p className="text-slate-500">No active call</p>
        {/* Surfaces WHY the call just ended when it wasn't an ordinary
            hangup — a failed hold re-INVITE or a failed/unconfirmed
            transfer (see sip-context.tsx's classifyTermination usage in
            onCallHangup). Without this the explanation would vanish the
            instant the active-call card unmounts and got replaced by this
            one, leaving the agent with nothing but a call that "just
            ended". */}
        {callError && (
          <div className="flex flex-col items-center gap-1 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
            <p>{callError}</p>
            <button onClick={clearCallError} className="underline hover:text-yellow-300">
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  if (callState === "ringing") {
    return (
      <div className="glass-card flex w-full max-w-xs flex-col items-center gap-4 p-6">
        <PhoneIncoming className="h-8 w-8 text-cyan" />
        <p className="text-slate-200">Incoming call from {incomingCallerId ?? "Unknown"}</p>
        <div className="flex gap-3">
          <button onClick={answerCall} aria-label="Answer call" className="rounded-lg bg-cyan px-4 py-2 font-medium text-background">
            Answer
          </button>
          <button onClick={declineCall} aria-label="Decline call" className="rounded-lg bg-red-500/80 px-4 py-2 font-medium text-white">
            Decline
          </button>
        </div>
      </div>
    );
  }

  const switchMode = (mode: "blind" | "attended" | "conference") => {
    setTransferMode(mode);
    setConferenceStatus(null); // stale status must not survive a mode switch
    setTransferError(null);
  };

  const startTransfer = async () => {
    if (!transferTarget || transferBusy) return;
    setTransferError(null);
    setTransferBusy(true);
    try {
      if (transferMode === "blind") {
        await blindTransfer(transferTarget);
        setShowTransfer(false);
        setTransferTarget("");
      } else if (transferMode === "attended") {
        await startAttendedTransfer(transferTarget);
      } else {
        // Ad-hoc 3-way conference (Phase G) — entirely server-side
        // orchestration (AMI Redirect + Originate), not a sip.js call the
        // browser initiates itself; see that route's file-header comment for
        // the full flow and its confidence caveats.
        setConferenceStatus("Adding participant…");
        const res = await fetch("/api/calls/conference", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetNumber: transferTarget }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Conference failed");
        setConferenceStatus(`Conference started (room ${data.conferenceId})`);
        setShowTransfer(false);
        setTransferTarget("");
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Action failed";
      if (transferMode === "conference") setConferenceStatus(`Failed: ${text}`);
      else setTransferError(text);
    } finally {
      setTransferBusy(false);
    }
  };

  return (
    <div className="glass-card flex w-full max-w-xs flex-col gap-4 p-6">
      <p className="text-center text-sm uppercase tracking-wide text-slate-400">
        {callState === "held" ? "On hold" : "In call"}
      </p>
      {callError && (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
          <p>{callError}</p>
          <button onClick={clearCallError} className="shrink-0 underline hover:text-yellow-300">
            Dismiss
          </button>
        </div>
      )}
      {audioBlocked && (
        <button
          onClick={retryAudioPlayback}
          className="flex items-center justify-center gap-2 rounded-lg border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400 hover:bg-yellow-500/20"
        >
          <VolumeX className="h-4 w-4" />
          Audio blocked by browser — click to unmute
        </button>
      )}
      <div className="flex justify-center gap-3">
        <button
          onClick={toggleMute}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-border hover:border-cyan"
          aria-label={isMuted ? "Unmute" : "Mute"}
          disabled={consultState !== "idle"}
        >
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <button
          onClick={() => {
            // toggleHold itself has an internal try/catch (see
            // sip-context.tsx) that never lets a hold/unhold rejection go
            // unhandled — this .catch is a second, redundant backstop, not
            // the primary handling. It existing at all replaces what used
            // to be nothing: an onClick calling an async function with no
            // .catch, i.e. a guaranteed unhandled promise rejection on any
            // failure path that try/catch didn't anticipate.
            toggleHold().catch((err) => console.error("toggleHold failed unexpectedly:", err));
          }}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-border hover:border-cyan"
          aria-label={callState === "held" ? "Resume call" : "Hold call"}
          disabled={consultState !== "idle"}
        >
          {callState === "held" ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
        </button>
        <button
          onClick={() => setShowTransfer((v) => !v)}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-border hover:border-cyan"
          aria-label="Transfer or conference"
          disabled={consultState !== "idle"}
        >
          <PhoneForwarded className="h-5 w-5" />
        </button>
        <button
          onClick={hangupCall}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/80 text-white"
          aria-label="Hang up"
          disabled={consultState !== "idle"}
        >
          <PhoneOff className="h-5 w-5" />
        </button>
      </div>

      {showTransfer && consultState === "idle" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            startTransfer();
          }}
          className="flex flex-col gap-2"
        >
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => switchMode("blind")}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${transferMode === "blind" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
            >
              Blind
            </button>
            <button
              type="button"
              onClick={() => switchMode("attended")}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${transferMode === "attended" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
            >
              Attended
            </button>
            <button
              type="button"
              onClick={() => switchMode("conference")}
              aria-label="Conference mode"
              className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${transferMode === "conference" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
            >
              <Users className="mx-auto h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex gap-2">
            <input
              value={transferTarget}
              onChange={(e) => setTransferTarget(e.target.value)}
              placeholder={transferMode === "conference" ? "Add participant" : "Transfer to extension"}
              aria-label={transferMode === "conference" ? "Participant number" : "Transfer target extension"}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-cyan"
            />
            <button type="submit" disabled={transferBusy} className="rounded-lg bg-blue px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
              {transferBusy ? "…" : transferMode === "blind" ? "Send" : "Call"}
            </button>
          </div>
          {transferError && <p className="text-xs text-red-400">{transferError}</p>}
          {transferMode === "conference" && conferenceStatus && (
            <p className="text-xs text-slate-500">{conferenceStatus}</p>
          )}
        </form>
      )}

      {/* Attended transfer in progress — primary call is held (see
          startAttendedTransfer's comment in sip-context.tsx) while this
          consult call to the transfer target is dialed/answered. */}
      {consultState !== "idle" && (
        <div className="flex flex-col gap-2 rounded-lg border border-cyan/40 bg-cyan/5 p-3">
          <p className="text-xs text-slate-400">
            {consultState === "calling" ? `Calling ${transferTarget}…` : `Connected to ${transferTarget}`}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() =>
                completeAttendedTransfer().catch((err) => {
                  // completeAttendedTransfer (sip-context.tsx) already
                  // wrote the same explanation to callError (rendered
                  // above, on both this card and the idle one) — this
                  // ALSO shows it right next to the buttons that caused
                  // it, rather than the generic "Complete transfer
                  // failed" this used to always show regardless of why.
                  const text = err instanceof Error ? err.message : "Complete transfer failed";
                  setTransferError(text);
                })
              }
              disabled={consultState !== "active"}
              className="flex-1 rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-background disabled:cursor-not-allowed disabled:opacity-40"
            >
              Complete Transfer
            </button>
            <button
              onClick={() => {
                cancelAttendedTransfer();
                setShowTransfer(false);
                setTransferTarget("");
              }}
              className="flex-1 rounded-lg border border-border px-3 py-1.5 text-xs text-slate-400 hover:border-red-400 hover:text-red-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {consultState === "idle" && !showTransfer && <EscalationPicker />}
    </div>
  );
}
