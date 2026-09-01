"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useSIP } from "@/contexts/sip-context";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function Dialpad() {
  const { makeCall, sendDtmf, callState, dialError, hangupCall } = useSIP();
  const [digits, setDigits] = useState("");

  // Keypress behavior is mode-dependent:
  //  - idle: the key edits the number-to-dial
  //  - active: the key is a DTMF tone into the live call ONLY — it used to
  //    ALSO append to `digits`, so digits accumulated invisibly during the
  //    call and re-enabled Call with garbage like "555#123" after hangup.
  //  - held: neither (a held leg is sendonly — DTMF would go nowhere).
  const onKeyPress = (key: string) => {
    if (callState === "active") {
      sendDtmf(key);
      return;
    }
    if (callState === "idle") {
      setDigits((d) => d + key);
    }
  };

  const onCall = () => {
    if (!digits) return;
    makeCall(digits);
  };

  // Clear the stale number when a call ends so the next call starts clean.
  useEffect(() => {
    if (callState === "idle") setDigits("");
  }, [callState]);

  return (
    <div className="glass-card flex w-full max-w-xs flex-col gap-4 p-6">
      <input
        value={digits}
        onChange={(e) => setDigits(e.target.value.replace(/[^\d*#+]/g, ""))}
        placeholder="Enter number"
        aria-label="Number to dial"
        disabled={callState !== "idle"}
        className="w-full rounded-lg border border-border bg-background px-4 py-2 text-center text-lg tracking-wider text-primary outline-none focus:border-cyan"
      />
      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((key) => (
          <button
            key={key}
            onClick={() => onKeyPress(key)}
            aria-label={callState === "active" ? `Send DTMF ${key}` : `Digit ${key}`}
            className={cn(
              "aspect-square rounded-full border border-border bg-surface text-lg font-medium text-primary",
              "transition hover:border-cyan hover:text-cyan active:scale-95"
            )}
          >
            {key}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onCall}
          disabled={!digits || callState !== "idle"}
          className="flex-1 rounded-lg bg-cyan px-4 py-2 font-medium text-accent-fg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Call
        </button>
        <button
          onClick={() => setDigits((d) => d.slice(0, -1))}
          disabled={!digits || callState !== "idle"}
          aria-label="Backspace"
          className="rounded-lg border border-border px-3 py-2 text-sm text-secondary hover:border-cyan hover:text-cyan disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⌫
        </button>
      </div>
      {callState !== "idle" && (
        <button
          onClick={() => hangupCall()}
          className="rounded-lg bg-danger-subtle px-4 py-2 text-sm font-medium text-primary transition hover:bg-danger"
        >
          End call
        </button>
      )}
      {dialError && <p className="text-xs text-danger">{dialError}</p>}
    </div>
  );
}
