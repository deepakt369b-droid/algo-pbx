"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Mic, MicOff, Pause, Play, PhoneOff, Maximize2, ChevronDown } from "lucide-react";
import { useSIP } from "@/contexts/sip-context";
import { useCrmCallContext } from "@/components/crm/crm-call-context";
import { formatUnknownCaller } from "@/lib/caller-id-format";
import { cn } from "@/lib/utils";

// CallPopover (node W, W2) — a floating panel, bottom-right, a *view onto*
// the one app-wide SIP session (SIPProvider already wraps the agent shell,
// so the call survives navigation and this needs no context change). Mount
// point: src/app/agent/layout.tsx. Visible whenever callState is not idle.
//
// Every telephony action here is a READ of useSIP()'s exported surface —
// makeCall/hangupCall/toggleMute/toggleHold. sip-context.tsx is not touched.

const STATE_LABEL: Record<string, string> = {
  calling: "Calling…",
  ringing: "Incoming call",
  active: "On call",
  held: "On hold",
};

export function CallPopover() {
  const { callState, isMuted, toggleMute, toggleHold, hangupCall, incomingCallerId, callError } = useSIP();
  const { identity } = useCrmCallContext();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Re-expand whenever a new call starts.
  useEffect(() => {
    if (callState !== "idle") setCollapsed(false);
  }, [callState]);

  if (callState === "idle") return null;

  const displayName =
    identity?.contactName ||
    (identity?.number ? identity.number : null) ||
    (incomingCallerId ? formatUnknownCaller(incomingCallerId).replace(/^Unknown — /, "") : "Unknown");

  const canControl = callState === "active" || callState === "held";

  const run = async (fn: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 z-40 w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden",
        "rounded-[var(--radius-lg)] border bg-surface shadow-xl [border-color:rgb(var(--hairline))]",
      )}
      role="region"
      aria-label="Active call"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 [border-color:rgb(var(--hairline))]">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
          {STATE_LABEL[callState] ?? callState}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand call panel" : "Collapse call panel"}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius)] text-tertiary hover:bg-surface-hover hover:text-primary"
        >
          <ChevronDown size={14} className={cn("transition-transform", collapsed && "rotate-180")} />
        </button>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-3 px-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-primary">{displayName}</p>
            {identity?.contactId ? (
              <Link
                href={`/agent?contact=${identity.contactId}`}
                className="text-[12px] text-accent hover:underline"
              >
                Open in CRM
              </Link>
            ) : identity?.number ? (
              <p className="truncate text-[12px] text-secondary">{identity.number}</p>
            ) : null}
          </div>

          {callError && <p className="text-[12px] text-danger">{callError}</p>}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canControl || busy}
              onClick={() => run(toggleMute)}
              aria-pressed={isMuted}
              aria-label={isMuted ? "Unmute" : "Mute"}
              className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border text-secondary hover:bg-surface-hover disabled:opacity-40 [border-color:rgb(var(--hairline))]"
            >
              {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
            <button
              type="button"
              disabled={!canControl || busy}
              onClick={() => run(toggleHold)}
              aria-pressed={callState === "held"}
              aria-label={callState === "held" ? "Resume" : "Hold"}
              className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border text-secondary hover:bg-surface-hover disabled:opacity-40 [border-color:rgb(var(--hairline))]"
            >
              {callState === "held" ? <Play size={16} /> : <Pause size={16} />}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(hangupCall)}
              aria-label="Hang up"
              className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-danger text-white hover:opacity-90 disabled:opacity-40"
            >
              <PhoneOff size={16} />
            </button>
            <Link
              href="/agent/call"
              aria-label="Open full call view"
              className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] text-tertiary hover:bg-surface-hover hover:text-primary"
            >
              <Maximize2 size={15} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
