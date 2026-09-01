"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui";

export interface CrmContactSummary {
  id: string;
  numberE164: string;
  displayName: string | null;
  company: string | null;
  owner: { id: string; name: string } | null;
  updatedAt: string;
}

// P3 CRM contact list (LLM.md §28/29) — the left column of the new
// /agent home page. Search is server-side (GET /api/agent/crm/contacts?q=)
// rather than filtering a fully-loaded list, since a reseller deployment's
// contact count is unbounded and this must not assume "small enough to
// load once." Polling, not push — same convention as every other agent
// surface in this codebase (no SSE/WebSocket infra, see chat/*).
//
// Feature B2 (2026-08-31) — "Mine" (own + unowned) is the default scope;
// "All" is a deliberate opt-in switch, matching the operator's explicit
// one-contact-one-owner spec: an agent's everyday list should not be full
// of contacts they can't act on. The server (GET /api/agent/crm/contacts)
// enforces the same default independently — this toggle only changes which
// scope is requested, it isn't the only thing standing between an agent
// and someone else's contacts.
export function ContactList({
  selectedId,
  onSelect,
  refreshToken,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Bumped by the parent after a create/edit so the list re-fetches
   * without introducing its own separate polling loop. */
  refreshToken?: number;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [contacts, setContacts] = useState<CrmContactSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newNumber, setNewNumber] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    params.set("scope", scope);
    fetch(`/api/agent/crm/contacts?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        setContacts(data.contacts ?? []);
        setError(null);
      })
      .catch(() => setError("Could not load contacts."))
      .finally(() => setLoading(false));
  }, [query, scope]);

  useEffect(() => {
    setLoading(true);
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load, refreshToken]);

  const createContact = async () => {
    if (!newNumber.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/agent/crm/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numberE164: newNumber, displayName: newName || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`);
      setNewNumber("");
      setNewName("");
      setShowCreate(false);
      load();
      if (data.contact?.id) onSelect(data.contact.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create contact.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="glass-card flex h-[42rem] w-full flex-col gap-3 p-3 lg:w-96 lg:flex-shrink-0">
      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, number, company…"
          aria-label="Search contacts"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          title="New contact"
          aria-label="New contact"
          aria-expanded={showCreate}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border text-lg leading-none text-secondary hover:border-cyan hover:text-cyan"
        >
          +
        </button>
      </div>

      <div className="flex gap-1 rounded-lg border border-border p-0.5 text-xs">
        <button
          type="button"
          aria-pressed={scope === "mine"}
          onClick={() => setScope("mine")}
          className={`flex-1 rounded-md px-2 py-1.5 ${scope === "mine" ? "bg-cyan/10 text-cyan" : "text-secondary hover:text-primary"}`}
        >
          Mine
        </button>
        <button
          type="button"
          aria-pressed={scope === "all"}
          onClick={() => setScope("all")}
          className={`flex-1 rounded-md px-2 py-1.5 ${scope === "all" ? "bg-cyan/10 text-cyan" : "text-secondary hover:text-primary"}`}
        >
          All
        </button>
      </div>

      {showCreate && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
          <input
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            placeholder="Phone number"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-cyan"
          />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (optional)"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-cyan"
          />
          {createError && <p className="text-xs text-danger">{createError}</p>}
          <button
            onClick={createContact}
            disabled={creating}
            className="rounded-lg bg-cyan px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create contact"}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-1 p-1" aria-busy="true" aria-label="Loading contacts">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : error ? (
          <p className="p-3 text-sm text-danger">{error}</p>
        ) : contacts.length === 0 ? (
          <p className="p-3 text-sm text-tertiary">No contacts found.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {contacts.map((c) => {
              const isActive = c.id === selectedId;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onSelect(c.id)}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-border/40 ${
                      isActive ? "bg-cyan/10 text-cyan" : "text-primary"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium">{c.displayName || c.numberE164}</div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                          c.owner ? "bg-blue/10 text-blue" : "bg-surface-hover text-tertiary"
                        }`}
                      >
                        {c.owner ? c.owner.name : "Unowned"}
                      </span>
                    </div>
                    <div className="text-xs text-tertiary">
                      {c.displayName ? c.numberE164 : ""}
                      {c.company ? ` · ${c.company}` : ""}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
