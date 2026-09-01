"use client";

import { useCallback, useEffect, useState } from "react";

interface UnassignedContact {
  id: string;
  numberE164: string;
  displayName: string | null;
  company: string | null;
  updatedAt: string;
}
interface AgentCount {
  owner: { id: string; name: string; email: string; disabled: boolean } | null;
  contactCount: number;
}
interface StaffUser {
  id: string;
  name: string;
  role: "AGENT" | "SUPERVISOR" | "ADMIN";
  disabled: boolean;
}
interface TransferRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "DECLINED";
  createdAt: string;
  contact: { id: string; displayName: string | null; numberE164: string };
  requestedBy: { id: string; name: string };
  currentOwner: { id: string; name: string };
}

// Feature B5 (2026-08-31) — manager view over one-contact-one-owner: the
// unassigned pool (grows automatically on agent deactivation, B6), a
// reassign action, per-agent counts, and the pending transfer-request
// queue (B3) — the "manager" half of "notifies owner + manager" made
// concrete as a page a supervisor/admin can check, since no push infra
// exists in this codebase. Placed at /admin/contact-ownership, NOT under
// /admin/contacts — that surface is owned by a separate, parallel agent
// working the same round (see this session's file-ownership split).
export default function ContactOwnershipPage() {
  const [unassigned, setUnassigned] = useState<UnassignedContact[]>([]);
  const [counts, setCounts] = useState<AgentCount[]>([]);
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [requests, setRequests] = useState<TransferRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [reassignTarget, setReassignTarget] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/admin/contact-ownership", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { unassigned: [], perAgentCounts: [] })),
      fetch("/api/admin/users", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { users: [] })),
      fetch("/api/agent/crm/transfer-requests?scope=incoming", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { requests: [] })),
    ])
      .then(([ownership, users, transfer]) => {
        setUnassigned(ownership.unassigned ?? []);
        setCounts(ownership.perAgentCounts ?? []);
        setStaff((users.users ?? []).filter((u: StaffUser) => !u.disabled));
        setRequests(transfer.requests ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 20_000);
    return () => clearInterval(interval);
  }, [load]);

  const reassign = async (contactId: string) => {
    const ownerId = reassignTarget[contactId];
    if (!ownerId) return;
    setMessage(null);
    const res = await fetch(`/api/admin/contact-ownership/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setMessage(data?.error ?? "Reassign failed.");
      return;
    }
    load();
  };

  const decideTransfer = async (id: string, action: "approve" | "decline") => {
    setMessage(null);
    const res = await fetch(`/api/agent/crm/transfer-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setMessage(data?.error ?? "Failed to decide transfer request.");
      return;
    }
    load();
  };

  if (loading) return <p className="text-center text-sm text-tertiary">Loading…</p>;

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Contact Ownership</h1>
      <p className="max-w-xl text-center text-xs text-tertiary">
        One contact, one owner. Deactivating an agent (Users → disable) automatically returns their contacts here.
      </p>
      {message && <p className="text-xs text-danger">{message}</p>}

      <div className="glass-card w-full max-w-3xl p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">
          Pending transfer requests ({requests.length})
        </h2>
        {requests.length === 0 ? (
          <p className="text-sm text-tertiary">None pending.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-primary">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 border-t border-border pt-2 first:border-0 first:pt-0">
                <div>
                  <p>
                    {r.requestedBy.name} wants {r.contact.displayName || r.contact.numberE164} from {r.currentOwner.name}
                  </p>
                  <p className="text-xs text-tertiary">{new Date(r.createdAt).toLocaleString()}</p>
                </div>
                <div className="flex shrink-0 gap-2 text-xs">
                  <button onClick={() => decideTransfer(r.id, "approve")} className="rounded-lg bg-cyan px-3 py-1.5 font-medium text-accent-fg">
                    Approve
                  </button>
                  <button onClick={() => decideTransfer(r.id, "decline")} className="rounded-lg border border-border px-3 py-1.5 text-secondary hover:border-danger/40 hover:text-danger">
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="glass-card w-full max-w-3xl p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">
          Unassigned pool ({unassigned.length})
        </h2>
        {unassigned.length === 0 ? (
          <p className="text-sm text-tertiary">Nothing unassigned.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-primary">
            {unassigned.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-0 first:pt-0">
                <div>
                  <p>{c.displayName || c.numberE164}</p>
                  <p className="text-xs text-tertiary">
                    {c.company ? `${c.company} · ` : ""}last activity {new Date(c.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <select
                    value={reassignTarget[c.id] ?? ""}
                    onChange={(e) => setReassignTarget((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    className="rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus:border-cyan"
                  >
                    <option value="">Assign to…</option>
                    {staff.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => reassign(c.id)}
                    disabled={!reassignTarget[c.id]}
                    className="rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
                  >
                    Assign
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="glass-card w-full max-w-3xl p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">Contacts per agent</h2>
        {counts.length === 0 ? (
          <p className="text-sm text-tertiary">No owned contacts yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-primary">
            {counts.map((c) => (
              <li key={c.owner?.id ?? "unknown"} className="flex items-center justify-between border-t border-border pt-2 first:border-0 first:pt-0">
                <span>{c.owner?.name ?? "(deleted user)"}</span>
                <span className="text-secondary">{c.contactCount}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
