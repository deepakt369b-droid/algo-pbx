"use client";

import { useEffect, useState } from "react";
import { Button, Textarea } from "@/components/ui";

// Threaded notes, reused on every CRM surface that needs one — deal, company
// and contact detail views (owner-page enchanted-sphinx plan, W5: "there is
// no 'notes/description' section in any of the crm pages"). `endpoint` is
// the note collection's own GET/POST URL, e.g.
// "/api/admin/crm/deals/<id>/notes" — this component owns no business logic
// beyond composing and listing; every route already does its own auth,
// idempotency (via the shared refId convention in src/lib/crm/notes.ts) and
// Activity-timeline write.

export interface NoteThreadItem {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string | null };
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function NoteThread({ endpoint }: { endpoint: string }) {
  const [notes, setNotes] = useState<NoteThreadItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    fetch(endpoint, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => setNotes(data.notes ?? []))
      .catch(() => setLoadError("Could not load notes."));
  }

  useEffect(load, [endpoint]);

  async function submit() {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "Could not post that note.");
      setDraft("");
      load();
    } catch (err) {
      setPostError(err instanceof Error ? err.message : "Could not post that note.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Add a note..."
          aria-label="New note"
        />
        <div className="flex items-center justify-between">
          {postError && <p className="text-[12px] text-danger">{postError}</p>}
          <Button size="sm" className="ml-auto" disabled={!draft.trim() || posting} onClick={submit}>
            {posting ? "Posting…" : "Add note"}
          </Button>
        </div>
      </div>

      {loadError && <p className="text-[12px] text-danger">{loadError}</p>}
      {notes === null ? (
        <p className="text-[12px] text-tertiary">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-[12px] text-tertiary">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-[var(--radius)] border p-2.5 text-[13px] [border-color:rgb(var(--hairline))]">
              <p className="whitespace-pre-wrap text-primary">{n.body}</p>
              <p className="mt-1 text-[11px] text-tertiary">
                {n.author.name ?? "Unknown"} · {fmtDateTime(n.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
