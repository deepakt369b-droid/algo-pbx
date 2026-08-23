"use client";

import { useState } from "react";
import { Mic, MicOff, Pause, Play, PhoneOff, PhoneForwarded, PhoneIncoming, Users, VolumeX } from "lucide-react";
import { useSIP } from "@/contexts/sip-context";

export function CallControls() {
  const {
    callState,
    isMuted,
    incomingCallerId,
    answerCall,
    hangupCall,
    toggleMute,
    toggleHold,
    blindTransfer,
    consultState,
    startAttendedTransfer,
    completeAttendedTransfer,
    cancelAttendedTransfer,
    audioBlocked,
    retryAudioPlayback,
  } = useSIP();
  const [transferTarget, setTransferTarget] = useState("");
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferMode, setTransferMode] = useState<"blind" | "attended" | "conference">("blind");
  const [conferenceStatus, setConferenceStatus] = useState<string | null>(null);

  if (callState === "idle") {
    return <div className="glass-card w-full max-w-xs p-6 text-center text-slate-500">No active call</div>;
  }

  if (callState === "ringing") {
    return (
      <div className="glass-card flex w-full max-w-xs flex-col items-center gap-4 p-6">
        <PhoneIncoming className="h-8 w-8 text-cyan" />
        <p className="text-slate-200">Incoming call from {incomingCallerId ?? "Unknown"}</p>
        <div className="flex gap-3">
          <button onClick={answerCall} className="rounded-lg bg-cyan px-4 py-2 font-medium text-background">
            Answer
          </button>
          <button onClick={hangupCall} className="rounded-lg bg-red-500/80 px-4 py-2 font-medium text-white">
            Decline
          </button>
        </div>
      </div>
    );
  }

  const startTransfer = async () => {
    if (!transferTarget) return;
    if (transferMode === "blind") {
      blindTransfer(transferTarget);
      setShowTransfer(false);
      setTransferTarget("");
    } else if (transferMode === "attended") {
      startAttendedTransfer(transferTarget);
    } else {
      // Ad-hoc 3-way conference (Phase G) — entirely server-side
      // orchestration (AMI Redirect + Originate), not a sip.js call the
      // browser initiates itself; see that route's file-header comment for
      // the full flow and its confidence caveats.
      setConferenceStatus("Adding participant…");
      try {
        const res = await fetch("/api/calls/conference", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetNumber: transferTarget }),
        });
        const data = await res.json();
        setConferenceStatus(res.ok ? `Conference started (room ${data.conferenceId})` : `Failed: ${data.error}`);
      } catch {
        setConferenceStatus("Failed — network error");
      }
    }
  };

  return (
    <div className="glass-card flex w-full max-w-xs flex-col gap-4 p-6">
      <p className="text-center text-sm uppercase tracking-wide text-slate-400">
        {callState === "held" ? "On hold" : "In call"}
      </p>
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
          title={isMuted ? "Unmute" : "Mute"}
          disabled={consultState !== "idle"}
        >
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <button
          onClick={toggleHold}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-border hover:border-cyan"
          title={callState === "held" ? "Resume" : "Hold"}
          disabled={consultState !== "idle"}
        >
          {callState === "held" ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
        </button>
        <button
          onClick={() => setShowTransfer((v) => !v)}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-border hover:border-cyan"
          title="Transfer / Conference"
          disabled={consultState !== "idle"}
        >
          <PhoneForwarded className="h-5 w-5" />
        </button>
        <button
          onClick={hangupCall}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/80 text-white"
          title="Hang up"
          disabled={consultState !== "idle"}
        >
          <PhoneOff className="h-5 w-5" />
        </button>
      </div>

      {showTransfer && consultState === "idle" && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              onClick={() => setTransferMode("blind")}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${transferMode === "blind" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
            >
              Blind
            </button>
            <button
              onClick={() => setTransferMode("attended")}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${transferMode === "attended" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
            >
              Attended
            </button>
            <button
              onClick={() => setTransferMode("conference")}
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
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-cyan"
            />
            <button onClick={startTransfer} className="rounded-lg bg-blue px-3 py-1.5 text-sm font-medium text-white">
              {transferMode === "blind" ? "Send" : "Call"}
            </button>
          </div>
          {transferMode === "conference" && conferenceStatus && (
            <p className="text-xs text-slate-500">{conferenceStatus}</p>
          )}
        </div>
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
              onClick={completeAttendedTransfer}
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
    </div>
  );
}
