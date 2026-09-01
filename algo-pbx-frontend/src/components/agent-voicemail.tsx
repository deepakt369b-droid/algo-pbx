"use client";

import { useCallback, useEffect, useState } from "react";

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
// Because it is irreversible file deletion, the button now demands a
// two-click confirm (the component's own header comment asked for exactly
// this), and load/delete failures surface instead of vanishing.
export function AgentVoicemail() {
  const [messages, setMessages] = useState<VoicemailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/voicemail", { cache: "no-store" });
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setMessages(data.messages ?? []);
    } catch {
      setError("Could not load voicemail.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  // Marks the inbox "seen" (clearing the unread badge in AgentShell) as
  // soon as it's rendered with at least one message — same pattern as
  // AgentMissedCalls's identical effect.
  useEffect(() => {
    if (messages.length > 0) {
      fetch("/api/voicemail", { method: "POST" }).catch(() => undefined);
    }
  }, [messages.length]);

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/voicemail/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
    } catch {
      setError("Could not delete that message — try again.");
      setConfirmDeleteId(null);
      return;
    }
    setConfirmDeleteId(null);
    load();
  };

  if (loading && messages.length === 0 && !error) return null;
  if (error && messages.length === 0) {
    return (
      <div className="glass-card w-full max-w-2xl p-6">
        <p className="text-xs text-danger">{error}</p>
      </div>
    );
  }
  if (messages.length === 0) return null;

  return (
    <div className="glass-card w-full max-w-2xl p-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">
        Voicemail
      </h2>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      <ul className="flex flex-col gap-3 text-sm text-primary">
        {messages.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-0 first:pt-0">
            <div>
              <p>{m.callerId ?? "Unknown caller"}</p>
              <p className="text-xs text-tertiary">
                {m.origtime ? new Date(m.origtime * 1000).toLocaleString() : "—"}
                {m.durationSec ? ` · ${m.durationSec}s` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <audio controls src={m.audioUrl} className="h-8" />
              {confirmDeleteId === m.id ? (
                <span className="flex items-center gap-1 text-xs">
                  <button onClick={() => remove(m.id)} className="text-danger hover:text-danger">
                    Confirm
                  </button>
                  <button onClick={() => setConfirmDeleteId(null)} className="text-tertiary">
                    x
                  </button>
                </span>
              ) : (
                <button onClick={() => setConfirmDeleteId(m.id)} className="text-xs text-tertiary hover:text-danger">
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
