"use client";

import { cn } from "@/lib/utils";
import { useSIP } from "@/contexts/sip-context";
import type { AgentStatus } from "@/types";

const STATUSES: { value: AgentStatus; label: string; color: string }[] = [
  { value: "AVAILABLE", label: "Available", color: "bg-emerald-500" },
  { value: "BUSY", label: "Busy", color: "bg-amber-500" },
  { value: "BREAK", label: "On Break", color: "bg-blue" },
  { value: "OFFLINE", label: "Offline", color: "bg-slate-500" },
];

export function AgentStatusSelector() {
  const { agentStatus, setAgentStatus } = useSIP();

  return (
    <div className="glass-card flex w-full max-w-xs items-center justify-between gap-2 p-4">
      {STATUSES.map((s) => (
        <button
          key={s.value}
          onClick={() => setAgentStatus(s.value)}
          className={cn(
            "flex flex-1 flex-col items-center gap-1 rounded-lg px-2 py-2 text-xs transition",
            agentStatus === s.value ? "bg-surface text-slate-100" : "text-slate-500 hover:text-slate-300"
          )}
        >
          <span className={cn("h-2 w-2 rounded-full", s.color)} />
          {s.label}
        </button>
      ))}
    </div>
  );
}
