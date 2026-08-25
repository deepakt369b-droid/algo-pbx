"use client";

import { useEffect, useState } from "react";

interface DncEntry {
  id: string;
  numberE164: string;
  reason: string | null;
  source: string;
  createdAt: string;
  addedBy: { name: string } | null;
}

export default function DncPage() {
  const [entries, setEntries] = useState<DncEntry[]>([]);
  const [number, setNumber] = useState("");
  const [reason, setReason] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const load = () => {
    fetch("/api/dnc")
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        setEntries(data.entries ?? []);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load the DNC list."));
  };

  useEffect(load, []);

  const add = async () => {
    setMessage(null);
    const res = await fetch("/api/dnc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, reason: reason || undefined }),
    });
    const data = await res.json();
    if (res.ok) {
      setNumber("");
      setReason("");
      setMessage(`${number} added to the Do Not Call list.`);
      load();
    } else {
      setMessage(`Failed: ${data.error ?? "unknown error"}`);
    }
  };

  const remove = async (id: string, label: string) => {
    try {
      const res = await fetch(`/api/dnc/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage(`Could not remove ${label}: ${data.error ?? "unknown error"}`);
        return;
      }
      load();
    } finally {
      setConfirmRemoveId(null);
    }
  };

  const bulkImport = async () => {
    setMessage(null);
    const res = await fetch("/api/dnc/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: bulkText }),
    });
    const data = await res.json();
    if (res.ok) {
      setMessage(
        `Imported ${data.imported}.${data.skipped.length ? ` Skipped ${data.skipped.length} unparseable: ${data.skipped.join(", ")}` : ""}`
      );
      setBulkText("");
      load();
    } else {
      setMessage(`Failed: ${JSON.stringify(data.error ?? data)}`);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Do Not Call List</h1>
      <p className="max-w-md text-center text-xs text-slate-500">
        Blocks outbound dialing to these numbers from the softphone (immediate UX feedback) and,
        separately, at the Asterisk dialplan level (the enforcement that actually matters —
        see pbx_configs/func_odbc.conf).
      </p>

      {loadError && (
        <div className="w-full max-w-md rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">
          {loadError}
        </div>
      )}

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Add a number</h2>
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="Phone number, e.g. 050 123 4567 or +14155552671"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button onClick={add} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background">
          Add
        </button>
      </div>

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Bulk import</h2>
        <textarea
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          placeholder={"One number per line, e.g.:\n+971501234567\n0501234568"}
          rows={5}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button onClick={bulkImport} className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-white">
          Import
        </button>
        {message && <p className="text-xs text-slate-500">{message}</p>}
      </div>

      <div className="glass-card w-full max-w-md p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Blocked Numbers ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <p className="text-slate-500">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-slate-200">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between border-t border-border pt-2 first:border-0 first:pt-0">
                <div>
                  <p>{e.numberE164}</p>
                  {e.reason && <p className="text-xs text-slate-500">{e.reason}</p>}
                </div>
                {confirmRemoveId === e.id ? (
                  <span className="flex items-center gap-2 text-xs">
                    <button onClick={() => remove(e.id, e.numberE164)} className="text-red-400 hover:text-red-300">
                      Confirm
                    </button>
                    <button onClick={() => setConfirmRemoveId(null)} className="text-slate-500">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmRemoveId(e.id)} className="text-xs text-red-400 hover:text-red-300">
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
