"use client";

import { useEffect, useState } from "react";

interface Contact {
  id: string;
  numberE164: string;
  displayName: string | null;
  updatedAt: string;
}

// Session-authenticated Contacts directory (ADMIN/SUPERVISOR, via
// requireStaffSession on GET/POST/PATCH/DELETE /api/admin/contacts — see
// that route's header comment for why, and how it differs from the
// bearer-API-key GET/POST /api/crm/contacts used by an external CRM).
// Every other messaging surface (conversation-list.tsx, admin/sms/page.tsx)
// already reads `contact.displayName ?? contact.numberE164` off a join —
// this page is where that displayName actually gets set.
export default function ContactsAdminPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [number, setNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const load = (q?: string) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    fetch(`/api/admin/contacts?${params.toString()}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        setContacts(data.contacts ?? []);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load contacts."))
      .finally(() => setLoading(false));
  };

  useEffect(() => load(), []);

  const applySearch = () => load(query || undefined);
  const resetSearch = () => {
    setQuery("");
    load();
  };

  const create = async () => {
    setMessage(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number, displayName: displayName || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setNumber("");
        setDisplayName("");
        setMessage(`${data.contact.numberE164} added.`);
        load(query || undefined);
      } else {
        setMessage(`Failed: ${data.error ?? "unknown error"}`);
      }
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (c: Contact) => {
    setEditingId(c.id);
    setEditName(c.displayName ?? "");
  };

  const saveEdit = async (id: string) => {
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/admin/contacts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: editName || null }),
      });
      const data = await res.json();
      if (res.ok) {
        setEditingId(null);
        load(query || undefined);
      } else {
        setMessage(`Failed: ${data.error ?? "unknown error"}`);
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async (id: string, label: string) => {
    try {
      const res = await fetch(`/api/admin/contacts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage(`Could not remove ${label}: ${data.error ?? "unknown error"}`);
        return;
      }
      load(query || undefined);
    } finally {
      setConfirmRemoveId(null);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Contacts</h1>
      <p className="max-w-2xl text-center text-xs text-slate-500">
        Display names for phone numbers, shared across the SMS/WhatsApp inbox, CDR, and missed-call
        views. A number with no contact here falls back to displaying its raw digits.
      </p>

      {loadError && (
        <div className="w-full max-w-md rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">
          {loadError}
        </div>
      )}

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Add a contact</h2>
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="Phone number, e.g. 050 123 4567 or +14155552671"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Display name (optional)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button
          onClick={create}
          disabled={creating || !number}
          className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {creating ? "Adding…" : "Add"}
        </button>
        {message && <p className="text-xs text-slate-500">{message}</p>}
      </div>

      <div className="glass-card w-full max-w-2xl p-6">
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            Search
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or number"
              className="w-64 rounded border border-border bg-background px-2 py-1 text-sm text-slate-100 outline-none focus:border-cyan"
            />
          </label>
          <button onClick={applySearch} className="rounded bg-cyan px-3 py-1.5 text-xs font-medium text-background">
            Apply
          </button>
          <button onClick={resetSearch} className="text-xs text-slate-400 hover:text-slate-200">
            Reset
          </button>
        </div>

        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Contacts ({contacts.length})
        </h2>
        {loading && <p className="text-slate-500">Loading contacts…</p>}
        {!loading && contacts.length === 0 && <p className="text-slate-500">No contacts yet.</p>}
        {!loading && contacts.length > 0 && (
          <ul className="flex flex-col gap-2 text-sm text-slate-200">
            {contacts.map((c) => (
              <li key={c.id} className="flex items-center justify-between border-t border-border pt-2 first:border-0 first:pt-0">
                {editingId === c.id ? (
                  <div className="flex flex-1 items-center gap-2">
                    <span className="text-xs text-slate-500">{c.numberE164}</span>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Display name"
                      className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-slate-100 outline-none focus:border-cyan"
                    />
                    <button
                      onClick={() => saveEdit(c.id)}
                      disabled={savingEdit}
                      className="text-xs text-cyan hover:text-cyan/80 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button onClick={() => setEditingId(null)} className="text-xs text-slate-500 hover:text-slate-300">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div>
                      <p>{c.displayName ?? c.numberE164}</p>
                      {c.displayName && <p className="text-xs text-slate-500">{c.numberE164}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                      <button onClick={() => startEdit(c)} className="text-xs text-blue hover:text-blue/80">
                        Edit
                      </button>
                      {confirmRemoveId === c.id ? (
                        <span className="flex items-center gap-2 text-xs">
                          <button
                            onClick={() => remove(c.id, c.displayName ?? c.numberE164)}
                            className="text-red-400 hover:text-red-300"
                          >
                            Confirm
                          </button>
                          <button onClick={() => setConfirmRemoveId(null)} className="text-slate-500">
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmRemoveId(c.id)} className="text-xs text-red-400 hover:text-red-300">
                          Remove
                        </button>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
