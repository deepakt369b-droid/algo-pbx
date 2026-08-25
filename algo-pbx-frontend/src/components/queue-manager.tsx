"use client";

import { useEffect, useState } from "react";
import type { QueueSnapshot } from "@/types";
import { apiFetch, ApiError } from "@/lib/client/api";

// Live queue manager with REAL mutation controls (was read-only despite its
// title — see handoff.md's audit). Per member: pause/unpause (pull out of
// / put back into rotation) and remove; plus add-member by extension
// number. Mutations POST to /api/queues/members, which fans out through the
// same AMI helpers provisioning uses. The list refreshes after every action
// so the AMI-reported status is what you see, not an optimistic guess.
export function QueueManager() {
  const [queues, setQueues] = useState<QueueSnapshot[]>([]);
  const [amiConnected, setAmiConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [addExt, setAddExt] = useState("");
  const [addingFor, setAddingFor] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await apiFetch<{ queues: QueueSnapshot[]; amiConnected: boolean }>("/api/queues");
      setQueues(data.queues ?? []);
      setAmiConnected(data.amiConnected ?? true);
    } catch {
      setMessage({ kind: "error", text: "Could not load queue snapshots." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const mutate = async (queue: string, extension: string, action: "add" | "remove" | "pause" | "unpause", key: string) => {
    setBusyKey(key);
    setMessage(null);
    try {
      await apiFetch("/api/queues/members", { method: "POST", body: { queue, extension, action } });
      setMessage({ kind: "ok", text: `${action} ${extension} on ${queue}: done.` });
      await load();
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "Action failed.",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const addMember = async (queue: string) => {
    if (!/^\d{3,6}$/.test(addExt)) {
      setMessage({ kind: "error", text: "Extension must be 3-6 digits." });
      return;
    }
    await mutate(queue, addExt, "add", `add:${queue}`);
    setAddExt("");
    setAddingFor(null);
  };

  if (loading) return <p className="text-slate-500">Loading queues…</p>;

  return (
    <div className="glass-card w-full max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Queue &amp; Ring Group Manager
        </h2>
        {!amiConnected && (
          <span className="rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">
            Asterisk unreachable — live state unavailable
          </span>
        )}
      </div>

      {message && (
        <p className={`mb-3 rounded px-3 py-1.5 text-xs ${message.kind === "error" ? "bg-red-950/50 text-red-300" : "bg-green-950/40 text-green-300"}`}>
          {message.text}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {queues.length === 0 && <p className="text-slate-500">No queues configured yet.</p>}
        {queues.map((q) => (
          <div key={q.name} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-100">{q.name}</p>
                <p className="text-xs text-slate-500">strategy: {q.strategy}</p>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <span className="text-slate-400">{q.members.length} members</span>
                <span className="text-slate-400">{q.waiting} waiting</span>
              </div>
            </div>

            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {q.members.map((m) => (
                <li key={`${q.name}:${m.extension}`} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-200">{m.extension}</span>
                    <span className={`text-xs ${m.status === "AVAILABLE" ? "text-green-400" : m.status === "PAUSED" ? "text-yellow-400" : "text-slate-500"}`}>
                      {m.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={!amiConnected || busyKey !== null}
                      onClick={() => mutate(q.name, m.extension, m.status === "PAUSED" ? "unpause" : "pause", `${q.name}:${m.extension}:p`)}
                      className="rounded border border-border px-2 py-0.5 text-xs text-slate-300 hover:border-cyan hover:text-cyan disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busyKey === `${q.name}:${m.extension}:p` ? "…" : m.status === "PAUSED" ? "Unpause" : "Pause"}
                    </button>
                    <button
                      disabled={!amiConnected || busyKey !== null}
                      onClick={() => mutate(q.name, m.extension, "remove", `${q.name}:${m.extension}:r`)}
                      className="rounded border border-border px-2 py-0.5 text-xs text-red-400 hover:border-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
              {q.members.length === 0 && (
                <li className="py-2 text-xs text-slate-600">No members in rotation.</li>
              )}
            </ul>

            {addingFor === q.name ? (
              <div className="flex items-center gap-2">
                <input
                  value={addExt}
                  onChange={(e) => setAddExt(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="Extension number"
                  autoFocus
                  className="w-36 rounded border border-border bg-background px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan"
                />
                <button
                  disabled={!amiConnected || busyKey !== null}
                  onClick={() => addMember(q.name)}
                  className="rounded bg-cyan px-2 py-1 text-xs font-medium text-background disabled:opacity-40"
                >
                  Add
                </button>
                <button onClick={() => { setAddingFor(null); setAddExt(""); }} className="text-xs text-slate-500">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                disabled={!amiConnected}
                onClick={() => { setAddingFor(q.name); setAddExt(""); }}
                className="self-start text-xs text-cyan hover:underline disabled:cursor-not-allowed disabled:opacity-40"
              >
                + Add member
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
