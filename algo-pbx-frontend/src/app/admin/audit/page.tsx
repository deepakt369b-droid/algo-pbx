"use client";

import { useEffect, useState } from "react";

interface AuditLogRow {
  id: string;
  action: string;
  createdAt: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  actor: { id: string; name: string; email: string; role: string };
}

// The viewer AuditLog never had (Loop C3) — rows have been written since
// Phase D (recording hide/hard-delete, intervention, settings.update,
// sign-ins, and now password resets and extension deletion) but nothing
// in the product ever surfaced them. Filter-then-list, same shape as
// /admin/cdr — this table can grow large fast, so no client-side
// full-table load, filters are server-side query params.
export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [action, setAction] = useState("");
  const [actorEmail, setActorEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (actorEmail) params.set("actorEmail", actorEmail);
    fetch(`/api/admin/audit?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        setLogs(data.logs ?? []);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the audit log."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Audit Log</h1>
      <p className="max-w-xl text-center text-xs text-tertiary">
        Every recorded administrative/security-relevant action — sign-ins, recording hide/delete, supervisor
        intervention, settings changes, password resets, extension deletion.
      </p>

      <div className="glass-card flex w-full max-w-3xl flex-wrap gap-2 p-4">
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Filter by action, e.g. user.password_reset"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <input
          value={actorEmail}
          onChange={(e) => setActorEmail(e.target.value)}
          placeholder="Filter by actor email"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button onClick={load} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg">
          Filter
        </button>
      </div>

      {error && (
        <div className="w-full max-w-3xl rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
          {error}
        </div>
      )}

      <div className="glass-card w-full max-w-3xl overflow-x-auto p-6">
        {loading ? (
          <p className="text-tertiary">Loading…</p>
        ) : logs.length === 0 ? (
          <p className="text-tertiary">No matching entries.</p>
        ) : (
          <table className="w-full text-left text-xs text-secondary">
            <thead>
              <tr className="border-b border-border text-tertiary">
                <th className="pb-2 pr-3">When</th>
                <th className="pb-2 pr-3">Action</th>
                <th className="pb-2 pr-3">Actor</th>
                <th className="pb-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-border/50">
                  <td className="py-2 pr-3 whitespace-nowrap text-tertiary">{new Date(l.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-3 font-mono text-cyan">{l.action}</td>
                  <td className="py-2 pr-3">
                    {l.actor.name} <span className="text-tertiary">({l.actor.role})</span>
                  </td>
                  <td className="py-2 text-tertiary">
                    {l.targetId && <span className="mr-2">target: {l.targetId}</span>}
                    {l.metadata && Object.keys(l.metadata).length > 0 && <span className="break-all">{JSON.stringify(l.metadata)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
