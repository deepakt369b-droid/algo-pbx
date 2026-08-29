"use client";

import { PhoneIncoming } from "lucide-react";
import { useSIP } from "@/contexts/sip-context";

// A ringing call's Answer/Decline UI previously existed ONLY inside
// CallControls, which is mounted exclusively on /agent (src/app/agent/page.tsx).
// SIPProvider lives in the root layout, so the softphone rings on every
// agent route — /agent/chat, /agent/calls, /agent/voicemail, /agent/missed
// — but on all of them the agent heard the ringtone with no way to answer.
// Reported live 2026-08-29: an inbound GSM call rang for the full 15s
// RINGNOANSWER window and was abandoned by the caller while the agent was
// on /agent/chat.
//
// This banner is the fix: mounted once in AgentShell (which wraps every
// agent route), rendered only while callState === "ringing" AND the agent
// is NOT already on /agent (CallControls' own ringing card covers that
// page — showing both would be a confusing duplicate, not a redundant
// safety net, since they'd render at different scroll positions).
export function IncomingCallBanner({ hidden }: { hidden: boolean }) {
  const { callState, incomingCallerId, answerCall, declineCall } = useSIP();

  if (hidden || callState !== "ringing") return null;

  return (
    <div
      role="alert"
      className="glass-card sticky top-[57px] z-20 mx-auto mt-2 flex w-full max-w-md items-center justify-between gap-4 border-cyan/40 p-4 shadow-lg"
    >
      <div className="flex items-center gap-3">
        <PhoneIncoming className="h-6 w-6 flex-shrink-0 animate-pulse text-cyan" />
        <p className="text-sm text-slate-100">Incoming call from {incomingCallerId ?? "Unknown"}</p>
      </div>
      <div className="flex flex-shrink-0 gap-2">
        <button
          onClick={answerCall}
          aria-label="Answer call"
          className="rounded-lg bg-cyan px-3 py-1.5 text-sm font-medium text-background"
        >
          Answer
        </button>
        <button
          onClick={declineCall}
          aria-label="Decline call"
          className="rounded-lg bg-red-500/80 px-3 py-1.5 text-sm font-medium text-white"
        >
          Decline
        </button>
      </div>
    </div>
  );
}
