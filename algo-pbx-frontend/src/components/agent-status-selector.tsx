"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useSIP } from "@/contexts/sip-context";
import type { AgentStatus } from "@/types";

const STATUSES: { value: AgentStatus; label: string; color: string }[] = [
  { value: "AVAILABLE", label: "Available", color: "bg-success" },
  { value: "BUSY", label: "Busy", color: "bg-warning" },
  { value: "BREAK", label: "On Break", color: "bg-blue" },
  { value: "OFFLINE", label: "Offline", color: "bg-surface-hover" },
];

export function AgentStatusSelector() {
  const { agentStatus, setAgentStatus } = useSIP();
  // A failed PATCH used to revert the optimistic status silently (the
  // click looked accepted, then quietly undid itself). Failures now show
  // here until the next successful change.
  const [error, setError] = useState<string | null>(null);

  const select = async (value: AgentStatus) => {
    setError(null);
    try {
      await setAgentStatus(value);
    } catch {
      setError("Could not save your status — check your connection and try again.");
    }
  };

  return (
    <div className="glass-card flex w-full max-w-xs flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2" role="radiogroup" aria-label="Agent status">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            role="radio"
            aria-checked={agentStatus === s.value}
            onClick={() => select(s.value)}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 rounded-lg px-2 py-2 text-xs transition",
              agentStatus === s.value ? "bg-surface text-primary" : "text-tertiary hover:text-primary"
            )}
          >
            <span className={cn("h-2 w-2 rounded-full", s.color)} />
            {s.label}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
