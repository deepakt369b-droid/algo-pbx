"use client";

import { useEffect, useState } from "react";

interface VoicemailMessage {
  id: string;
  callerId: string | null;
  origtime: number | null;
  durationSec: number | null;
  audioUrl: string;
}

// Agent's own voicemail inbox. Unlike Phase D's recordings ("Hide"), this
// Delete is genuinely destructive — see the DELETE route's file-header
// comment for why, and the flag that this asymmetry should be confirmed.
export function AgentVoicemail() {
  const [messages, setMessages] = useState<VoicemailMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    fetch("/api/voicemail")
      .then((r) => r.json())
      .then((data) => setMessages(data.messages ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const remove = async (id: string) => {
    await fetch(`/api/voicemail/${id}`, { method: "DELETE" });
    load();
  };

  if (loading) return null;
  if (messages.length === 0) return null;

  return (
    <div className="glass-card w-full max-w-2xl p-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Voicemail
      </h2>
      <ul className="flex flex-col gap-3 text-sm text-slate-200">
        {messages.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-0 first:pt-0">
            <div>
              <p>{m.callerId ?? "Unknown caller"}</p>
              <p className="text-xs text-slate-500">
                {m.origtime ? new Date(m.origtime * 1000).toLocaleString() : "—"}
                {m.durationSec ? ` · ${m.durationSec}s` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <audio controls src={m.audioUrl} className="h-8" />
              <button onClick={() => remove(m.id)} className="text-xs text-slate-500 hover:text-red-400">
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
