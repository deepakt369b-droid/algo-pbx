"use client";

import { useEffect, useState } from "react";
import type { WallboardSnapshot } from "@/types";

export function Wallboard() {
  const [snapshot, setSnapshot] = useState<(WallboardSnapshot & { amiConnected: boolean }) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/wallboard", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setSnapshot(data);
      } catch {
        // network hiccup — next poll retries
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="glass-card grid w-full max-w-3xl grid-cols-2 gap-6 p-6 md:grid-cols-4">
      <Stat label="Active Calls" value={snapshot?.activeCalls ?? "—"} />
      <Stat label="Agents Online" value={snapshot?.agentsOnline ?? "—"} />
      <Stat label="Queues" value={snapshot?.queues.length ?? "—"} />
      <Stat
        label="AMI Link"
        value={snapshot ? (snapshot.amiConnected ? "Connected" : "Down") : "—"}
        accent={snapshot && !snapshot.amiConnected ? "text-red-400" : "text-emerald-400"}
      />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`text-2xl font-semibold ${accent ?? "text-cyan"}`}>{value}</span>
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}
