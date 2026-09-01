"use client";

import { useEffect, useState } from "react";

interface EscalationTarget {
  id: string;
  name: string;
  extension: string | null;
  phoneE164: string | null;
  active: boolean;
}

interface EscalationAttempt {
  id: string;
  targetName: string;
  outcome: string;
  waNotified: boolean;
  waError: string | null;
  createdAt: string;
  agent: { name: string; email: string };
}

// Admin management of the manager-escalation named list (Loop C1) — a
// short admin-managed speed-dial (name + extension/number), so an agent's
// "get my manager" dropdown always resolves to a real, current person,
// plus the attempt log requested alongside the WhatsApp busy/no-answer
// notification.
export default function EscalationsPage() {
  const [targets, setTargets] = useState<EscalationTarget[]>([]);
  const [attempts, setAttempts] = useState<EscalationAttempt[]>([]);
  const [name, setName] = useState("");
  const [extension, setExtension] = useState("");
  const [phoneE164, setPhoneE164] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const loadTargets = () => {
    fetch("/api/admin/escalation-targets")
      .then((r) => (r.ok ? r.json() : { targets: [] }))
      .then((data) => setTargets(data.targets ?? []));
  };
  const loadAttempts = () => {
    fetch("/api/admin/escalation-attempts")
      .then((r) => (r.ok ? r.json() : { attempts: [] }))
      .then((data) => setAttempts(data.attempts ?? []));
  };

  useEffect(() => {
    loadTargets();
    loadAttempts();
    const interval = setInterval(loadAttempts, 20000);
    return () => clearInterval(interval);
  }, []);

  const add = async () => {
    setMessage(null);
    const res = await fetch("/api/admin/escalation-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, extension: extension || undefined, phoneE164: phoneE164 || undefined }),
    });
    const data = await res.json();
    if (res.ok) {
      setName("");
      setExtension("");
      setPhoneE164("");
      loadTargets();
    } else {
      setMessage(`Failed: ${JSON.stringify(data.error ?? data)}`);
    }
  };

  const toggleActive = async (t: EscalationTarget) => {
    await fetch(`/api/admin/escalation-targets/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !t.active }),
    });
    loadTargets();
  };

  const remove = async (id: string) => {
    await fetch(`/api/admin/escalation-targets/${id}`, { method: "DELETE" });
    setConfirmRemoveId(null);
    loadTargets();
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Manager Escalation</h1>
      <p className="max-w-md text-center text-xs text-tertiary">
        Managers agents can transfer a live call to with one click. If a target does not answer,
        the agent sees it immediately and (when the target has a WhatsApp number) they are pinged.
      </p>

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Add a manager</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, e.g. Priya (Ops Manager)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <input
          value={extension}
          onChange={(e) => setExtension(e.target.value)}
          placeholder="Internal extension (optional)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <input
          value={phoneE164}
          onChange={(e) => setPhoneE164(e.target.value)}
          placeholder="WhatsApp number, e.g. +971501234567 (optional)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button
          onClick={add}
          disabled={!name || (!extension && !phoneE164)}
          className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          Add
        </button>
        {message && <p className="text-xs text-danger">{message}</p>}
      </div>

      <div className="glass-card w-full max-w-md p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">Managers ({targets.length})</h2>
        {targets.length === 0 ? (
          <p className="text-tertiary">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-primary">
            {targets.map((t) => (
              <li key={t.id} className="flex items-center justify-between border-t border-border pt-2 first:border-0 first:pt-0">
                <div>
                  <p className={t.active ? "" : "text-tertiary line-through"}>{t.name}</p>
                  <p className="text-xs text-tertiary">{[t.extension, t.phoneE164].filter(Boolean).join(" · ")}</p>
                </div>
                <span className="flex items-center gap-2 text-xs">
                  <button onClick={() => toggleActive(t)} className="text-secondary hover:text-cyan">
                    {t.active ? "Deactivate" : "Reactivate"}
                  </button>
                  {confirmRemoveId === t.id ? (
                    <>
                      <button onClick={() => remove(t.id)} className="text-danger hover:text-danger">
                        Confirm
                      </button>
                      <button onClick={() => setConfirmRemoveId(null)} className="text-tertiary">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmRemoveId(t.id)} className="text-danger hover:text-danger">
                      Remove
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="glass-card w-full max-w-md p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">Recent Attempts</h2>
        {attempts.length === 0 ? (
          <p className="text-tertiary">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-primary">
            {attempts.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 border-t border-border pt-2 first:border-0 first:pt-0">
                <p>
                  {a.agent.name} → {a.targetName}{" "}
                  <span
                    className={
                      a.outcome === "ANSWERED"
                        ? "text-success"
                        : a.outcome === "UNKNOWN"
                          ? "text-tertiary"
                          : "text-warning"
                    }
                  >
                    {a.outcome}
                  </span>
                </p>
                <p className="text-xs text-tertiary">
                  {new Date(a.createdAt).toLocaleString()}
                  {a.waNotified && " · WhatsApp notified"}
                  {a.waError && ` · ${a.waError}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
