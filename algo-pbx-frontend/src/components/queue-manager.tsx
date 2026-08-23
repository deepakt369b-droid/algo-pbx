"use client";

import { useEffect, useState } from "react";
import type { QueueSnapshot } from "@/types";

export function QueueManager() {
  const [queues, setQueues] = useState<QueueSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/queues")
      .then((r) => r.json())
      .then((data) => setQueues(data.queues ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-slate-500">Loading queues…</p>;

  return (
    <div className="glass-card w-full max-w-3xl p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Queue & Ring Group Manager
      </h2>
      <div className="flex flex-col gap-3">
        {queues.length === 0 && <p className="text-slate-500">No queues configured yet.</p>}
        {queues.map((q) => (
          <div key={q.name} className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="font-medium text-slate-100">{q.name}</p>
              <p className="text-xs text-slate-500">strategy: {q.strategy}</p>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-slate-400">{q.members.length} members</span>
              <span className="text-slate-400">{q.waiting} waiting</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
