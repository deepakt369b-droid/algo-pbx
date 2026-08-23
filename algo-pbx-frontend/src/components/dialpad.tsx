"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useSIP } from "@/contexts/sip-context";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function Dialpad() {
  const { makeCall, sendDtmf, callState, dialError } = useSIP();
  const [digits, setDigits] = useState("");

  const onKeyPress = (key: string) => {
    setDigits((d) => d + key);
    // "held" removed: a held call's leg is sendonly/silent to the far
    // party (that's what hold means), so DTMF sent into it was previously
    // going nowhere audible — a minor but genuinely confusing bug (an
    // agent pressing keys "into" what looks like an active call while it's
    // actually on hold, with no feedback that nothing was received).
    if (callState === "active") {
      sendDtmf(key);
    }
  };

  const onCall = () => {
    if (!digits) return;
    makeCall(digits);
  };

  return (
    <div className="glass-card flex w-full max-w-xs flex-col gap-4 p-6">
      <input
        value={digits}
        onChange={(e) => setDigits(e.target.value.replace(/[^\d*#+]/g, ""))}
        placeholder="Enter number"
        className="w-full rounded-lg border border-border bg-background px-4 py-2 text-center text-lg tracking-wider text-slate-100 outline-none focus:border-cyan"
      />
      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((key) => (
          <button
            key={key}
            onClick={() => onKeyPress(key)}
            className={cn(
              "aspect-square rounded-full border border-border bg-surface text-lg font-medium text-slate-200",
              "transition hover:border-cyan hover:text-cyan active:scale-95"
            )}
          >
            {key}
          </button>
        ))}
      </div>
      <button
        onClick={onCall}
        disabled={!digits || callState !== "idle"}
        className="rounded-lg bg-cyan px-4 py-2 font-medium text-background transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Call
      </button>
      {dialError && <p className="text-xs text-red-400">{dialError}</p>}
    </div>
  );
}
