"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/ui";

// Caller-ID routing rules (2026-09-14 Tel-Agent gap analysis — independently
// designed, no third-party code; see prisma/schema.prisma's
// CallerRoutingRule header). Mirrors /admin/dnc's add-form + list +
// confirm-remove shape, minus that page's bulk-import machinery — a
// tenant-policy list like this is expected to hold a handful of rows, not a
// spreadsheet import.

type Action = "PASS" | "BLOCK" | "AI";

interface RoutingRule {
  id: string;
  pattern: string;
  action: Action;
  note: string | null;
  createdAt: string;
}

const ACTION_OPTIONS: { value: Action; label: string }[] = [
  { value: "PASS", label: "Pass — always send straight to the human queue" },
  { value: "BLOCK", label: "Block — always refuse the call" },
  { value: "AI", label: "AI — force this number to the AI (overrides a broader block/pass rule)" },
];

const ACTION_BADGE: Record<Action, string> = {
  PASS: "border-success/40 bg-success/10 text-success",
  BLOCK: "border-danger/40 bg-danger-subtle text-danger",
  AI: "border-cyan/40 bg-cyan/10 text-cyan",
};

export default function CallerRoutingPage() {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<Action>("PASS");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const load = () => {
    fetch("/api/admin/caller-routing")
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        setRules(data.rules ?? []);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load caller routing rules."));
  };

  useEffect(load, []);

  const add = async () => {
    setMessage(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/caller-routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern, action, note: note || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setPattern("");
        setNote("");
        setMessage(`Rule added for ${data.rule.pattern}.`);
        load();
      } else {
        setMessage(`Failed: ${typeof data.error === "string" ? data.error : "unknown error"}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string, label: string) => {
    try {
      const res = await fetch(`/api/admin/caller-routing/${id}`, { method: "DELETE" });
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

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Caller routing</h1>
      <p className="max-w-md text-center text-xs text-tertiary">
        Decide what happens for a specific caller before the AI/queue decision runs: always reach a
        human (Pass), always refuse (Block), or always meet the AI. A number with no rule here behaves
        exactly as it always has.
      </p>

      {loadError && (
        <div className="w-full max-w-md rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
          {loadError}
        </div>
      )}

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Add a rule</h2>
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="Number (+971501234567) or prefix (+9715*)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          data-testid="caller-routing-pattern"
        />
        <label className="flex flex-col gap-1 text-xs text-secondary">
          Action
          <Select aria-label="Action" value={action} onChange={(v) => setAction(v as Action)} options={ACTION_OPTIONS} />
        </label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button
          onClick={add}
          disabled={submitting || !pattern.trim()}
          className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          data-testid="caller-routing-add"
        >
          {submitting ? "Adding…" : "Add rule"}
        </button>
        {message && <p className="text-xs text-tertiary">{message}</p>}
      </div>

      <div className="glass-card w-full max-w-md p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">
          Rules ({rules.length})
        </h2>
        {rules.length === 0 ? (
          <p className="text-tertiary">None yet — every caller behaves as it always has.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-primary">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between border-t border-border pt-2 first:border-0 first:pt-0">
                <div>
                  <p className="flex items-center gap-2">
                    <span className="font-mono">{r.pattern}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${ACTION_BADGE[r.action]}`}>
                      {r.action}
                    </span>
                  </p>
                  {r.note && <p className="text-xs text-tertiary">{r.note}</p>}
                </div>
                {confirmRemoveId === r.id ? (
                  <span className="flex items-center gap-2 text-xs">
                    <button onClick={() => remove(r.id, r.pattern)} className="text-danger hover:text-danger">
                      Confirm
                    </button>
                    <button onClick={() => setConfirmRemoveId(null)} className="text-tertiary">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmRemoveId(r.id)} className="text-xs text-danger hover:text-danger">
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
