"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useSIP } from "@/contexts/sip-context";

interface Note {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string };
}
interface Task {
  id: string;
  title: string;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignee: { id: string; name: string };
}
interface Disposition {
  id: string;
  outcome: "INTERESTED" | "CALLBACK" | "NOT_INTERESTED" | "DNC";
  note: string | null;
  createdAt: string;
  agent: { id: string; name: string };
}
interface Deal {
  id: string;
  name: string;
  value: number;
  currency: string;
  isPrimary: boolean;
  stage: { id: string; name: string; isWon: boolean; isLost: boolean };
  owner: { id: string; name: string } | null;
}
interface ContactFull {
  id: string;
  numberE164: string;
  displayName: string | null;
  email: string | null;
  company: string | null;
  companyRel: { id: string; name: string; domain: string | null } | null;
  tags: string[];
  dncBlocked: boolean;
  owner: { id: string; name: string } | null;
  notes: Note[];
  tasks: Task[];
  dispositions: Disposition[];
  deals: Deal[];
}
// S2b — the timeline is now unified Activity rows (occurredAt desc, 100),
// not an on-the-fly CDR+ChatMessage merge. Every entry has the same shape.
type TimelineEntry = {
  type: "CALL" | "WHATSAPP" | "SMS" | "NOTE" | "DEAL_STAGE_CHANGE" | "TASK";
  timestamp: string;
  summary: string;
  actor: string | null;
  refId: string | null;
};

const TIMELINE_LABELS: Record<TimelineEntry["type"], string> = {
  CALL: "Call",
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  NOTE: "Note",
  DEAL_STAGE_CHANGE: "Deal",
  TASK: "Task",
};

const DISPOSITION_LABELS: Record<Disposition["outcome"], string> = {
  INTERESTED: "Interested",
  CALLBACK: "Callback",
  NOT_INTERESTED: "Not interested",
  DNC: "DNC",
};

// P3 CRM contact detail (LLM.md §28/29) — the right column of the new
// /agent home page: fields, notes, tasks, a disposition bar, and a merged
// calls+messages timeline. Call/WhatsApp actions reuse the app's real
// call/messaging paths (useSIP().makeCall, the same one Dialpad already
// uses; a Link into the existing /agent/chat deep-link resolver) rather
// than inventing a second way to do either.
//
// Feature B2 (2026-08-31) — when the viewer is NOT the owner (and not
// SUPERVISOR/ADMIN, who can always act — see contact-ownership.ts's
// canWriteContact, mirrored here client-side for UI purposes only; the
// routes below are the actual enforcement), the whole form goes read-only:
// no note/task/disposition writes, an "Owned by <agent>" badge, and the
// only action available is "Request transfer" (Feature B3).
export function ContactDetail({ contactId, onChanged }: { contactId: string; onChanged?: () => void }) {
  const { data: session } = useSession();
  const { makeCall, callState, dialError } = useSIP();
  const [contact, setContact] = useState<ContactFull | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [noteBody, setNoteBody] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [savingTask, setSavingTask] = useState(false);
  const [dispositionNote, setDispositionNote] = useState("");
  const [savingDisposition, setSavingDisposition] = useState<Disposition["outcome"] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Feature B3 — transfer request state for THIS contact/viewer.
  const [pendingTransferRequest, setPendingTransferRequest] = useState(false);
  const [requestingTransfer, setRequestingTransfer] = useState(false);

  // Feature C2 — "Who was this?" skippable name-entry prompt.
  const [nameGuess, setNameGuess] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameSkipped, setNameSkipped] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/agent/crm/contacts/${contactId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        setContact(data.contact);
        setTimeline(data.timeline ?? []);
        setError(null);
      })
      .catch(() => setError("Could not load this contact."))
      .finally(() => setLoading(false));
  }, [contactId]);

  useEffect(() => {
    setLoading(true);
    setNameSkipped(false);
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent/crm/transfer-requests?scope=mine", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((data) => {
        if (cancelled) return;
        const requests: { contact: { id: string }; status: string }[] = data.requests ?? [];
        setPendingTransferRequest(requests.some((r) => r.contact.id === contactId && r.status === "PENDING"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const viewerId = session?.user?.id;
  const viewerRole = session?.user?.role;
  const isStaff = viewerRole === "SUPERVISOR" || viewerRole === "ADMIN";
  const isOwner = !contact?.owner || contact.owner.id === viewerId;
  const canWrite = isStaff || isOwner;
  const readOnly = !canWrite;

  const addNote = async () => {
    if (!noteBody.trim() || savingNote) return;
    setSavingNote(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/agent/crm/contacts/${contactId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteBody }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to save note");
      setNoteBody("");
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save note.");
    } finally {
      setSavingNote(false);
    }
  };

  const addTask = async () => {
    if (!taskTitle.trim() || savingTask) return;
    setSavingTask(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/agent/crm/contacts/${contactId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: taskTitle }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to save task");
      setTaskTitle("");
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save task.");
    } finally {
      setSavingTask(false);
    }
  };

  const toggleTask = async (taskId: string, completed: boolean) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/agent/crm/contacts/${contactId}/tasks`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, completed }),
      });
      if (!res.ok) throw new Error("Failed to update task");
      load();
    } catch {
      setActionError("Failed to update task.");
    }
  };

  const recordDisposition = async (outcome: Disposition["outcome"]) => {
    if (savingDisposition) return;
    setSavingDisposition(outcome);
    setActionError(null);
    try {
      const res = await fetch("/api/agent/crm/dispositions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, outcome, note: dispositionNote || undefined }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to record disposition");
      setDispositionNote("");
      load();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to record disposition.");
    } finally {
      setSavingDisposition(null);
    }
  };

  const requestTransfer = async () => {
    if (requestingTransfer || pendingTransferRequest) return;
    setRequestingTransfer(true);
    setActionError(null);
    try {
      const res = await fetch("/api/agent/crm/transfer-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to request transfer");
      setPendingTransferRequest(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to request transfer.");
    } finally {
      setRequestingTransfer(false);
    }
  };

  const saveNameGuess = async () => {
    if (!nameGuess.trim() || savingName) return;
    setSavingName(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/agent/crm/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: nameGuess.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to save name");
      setNameGuess("");
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save name.");
    } finally {
      setSavingName(false);
    }
  };

  if (loading) return <div className="glass-card flex-1 p-6 text-sm text-tertiary">Loading…</div>;
  if (error || !contact) return <div className="glass-card flex-1 p-6 text-sm text-danger">{error ?? "Not found."}</div>;

  const canCall = callState === "idle";

  return (
    <div className="glass-card flex-1 overflow-y-auto p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-semibold text-primary">{contact.displayName || contact.numberE164}</h2>
          <p className="text-sm text-secondary">{contact.numberE164}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-tertiary">
            {contact.companyRel ? (
              <span className="rounded-full bg-surface-hover px-2 py-0.5 text-secondary">{contact.companyRel.name}</span>
            ) : (
              contact.company && <span>{contact.company}</span>
            )}
            {contact.email && <span>{contact.email}</span>}
            {contact.owner && (
              <span
                className={`rounded-full px-2 py-0.5 ${readOnly ? "bg-blue/20 text-blue" : "bg-surface-hover text-secondary"}`}
              >
                Owned by {contact.owner.name}
              </span>
            )}
            {contact.dncBlocked && <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-danger">DNC blocked</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <button
              onClick={() => makeCall(contact.numberE164)}
              disabled={!canCall}
              title={canCall ? "Call this contact" : `Cannot call — ${callState}`}
              className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              Call
            </button>
            <Link
              href={`/agent/chat?number=${encodeURIComponent(contact.numberE164)}`}
              className="rounded-lg border border-border px-4 py-2 text-sm text-primary hover:border-cyan hover:text-cyan"
            >
              WhatsApp
            </Link>
          </div>
          {readOnly && (
            <button
              onClick={requestTransfer}
              disabled={requestingTransfer || pendingTransferRequest}
              className="rounded-lg border border-blue/50 px-3 py-1.5 text-xs font-medium text-blue disabled:opacity-50"
            >
              {pendingTransferRequest ? "Transfer requested" : requestingTransfer ? "Requesting…" : "Request transfer"}
            </button>
          )}
        </div>
      </div>
      {dialError && <p className="mt-2 text-xs text-danger">{dialError}</p>}
      {actionError && <p className="mt-2 text-xs text-danger">{actionError}</p>}
      {readOnly && (
        <p className="mt-2 rounded-lg border border-blue/30 bg-blue/5 p-2 text-xs text-blue">
          This contact is owned by {contact.owner?.name}. The form is read-only — request a transfer to edit it.
        </p>
      )}

      {/* Feature C2 — "Who was this?" — only offered when there's something
          to name AND the viewer can actually write (a read-only viewer
          shouldn't be prompted to edit a contact they can't save). */}
      {canWrite && !contact.displayName && !nameSkipped && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-cyan/30 bg-cyan/5 p-3">
          <span className="text-xs text-secondary">Who was this?</span>
          <input
            value={nameGuess}
            onChange={(e) => setNameGuess(e.target.value)}
            placeholder="Enter a name…"
            onKeyDown={(e) => e.key === "Enter" && saveNameGuess()}
            className="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus:border-cyan"
          />
          <button onClick={saveNameGuess} disabled={savingName || !nameGuess.trim()} className="rounded-lg bg-cyan px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-50">
            {savingName ? "Saving…" : "Save"}
          </button>
          <button onClick={() => setNameSkipped(true)} className="text-xs text-tertiary hover:text-primary">
            Skip
          </button>
        </div>
      )}

      {/* Disposition bar */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
        <span className="text-xs text-tertiary">Disposition:</span>
        {(Object.keys(DISPOSITION_LABELS) as Disposition["outcome"][]).map((outcome) => (
          <button
            key={outcome}
            onClick={() => recordDisposition(outcome)}
            disabled={savingDisposition !== null || readOnly}
            className={`rounded-full border px-3 py-1 text-xs disabled:opacity-50 ${
              outcome === "DNC" ? "border-danger/40 text-danger hover:bg-danger-subtle" : "border-border text-secondary hover:border-cyan hover:text-cyan"
            }`}
          >
            {savingDisposition === outcome ? "Saving…" : DISPOSITION_LABELS[outcome]}
          </button>
        ))}
        <input
          value={dispositionNote}
          onChange={(e) => setDispositionNote(e.target.value)}
          placeholder="Optional note"
          disabled={readOnly}
          className="ml-auto min-w-[10rem] flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus:border-cyan disabled:opacity-50"
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Notes */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-primary">Notes</h3>
          {!readOnly && (
            <div className="flex gap-2">
              <input
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="Add a note…"
                onKeyDown={(e) => e.key === "Enter" && addNote()}
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-cyan"
              />
              <button onClick={addNote} disabled={savingNote} className="rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50">
                Add
              </button>
            </div>
          )}
          <ul className="mt-2 flex max-h-48 flex-col gap-2 overflow-y-auto">
            {contact.notes.length === 0 && <li className="text-xs text-tertiary">No notes yet.</li>}
            {contact.notes.map((n) => (
              <li key={n.id} className="rounded-lg border border-border p-2 text-xs">
                <p className="text-primary">{n.body}</p>
                <p className="mt-1 text-tertiary">
                  {n.author.name} · {new Date(n.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Tasks */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-primary">Tasks</h3>
          {!readOnly && (
            <div className="flex gap-2">
              <input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Add a task…"
                onKeyDown={(e) => e.key === "Enter" && addTask()}
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-cyan"
              />
              <button onClick={addTask} disabled={savingTask} className="rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50">
                Add
              </button>
            </div>
          )}
          <ul className="mt-2 flex max-h-48 flex-col gap-2 overflow-y-auto">
            {contact.tasks.length === 0 && <li className="text-xs text-tertiary">No tasks yet.</li>}
            {contact.tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-2 rounded-lg border border-border p-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(t.completedAt)}
                  onChange={(e) => toggleTask(t.id, e.target.checked)}
                  disabled={readOnly}
                  className="mt-0.5"
                />
                <div className={t.completedAt ? "text-tertiary line-through" : "text-primary"}>
                  {t.title}
                  <p className="text-tertiary">{t.assignee.name}{t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleDateString()}` : ""}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Timeline */}
      {/* Deals — S2b */}
      <section className="mt-5">
        <h3 className="mb-2 text-sm font-semibold text-primary">Deals</h3>
        {contact.deals.length === 0 ? (
          <p className="text-xs text-tertiary">No deals linked.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {contact.deals.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-xs">
                <span className="text-primary">
                  {d.name}
                  {d.isPrimary && <span className="ml-1 text-tertiary">(primary)</span>}
                </span>
                <span className="flex items-center gap-2 text-tertiary">
                  <span
                    className={
                      d.stage.isWon ? "text-success" : d.stage.isLost ? "text-danger" : "text-cyan"
                    }
                  >
                    {d.stage.name}
                  </span>
                  {d.currency} {d.value.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-5">
        <h3 className="mb-2 text-sm font-semibold text-primary">Timeline</h3>
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {timeline.length === 0 && <li className="text-xs text-tertiary">No activity yet.</li>}
          {timeline.map((entry, i) => (
            <li key={`${entry.type}-${entry.refId ?? i}-${i}`} className="rounded-lg border border-border p-2 text-xs">
              <span className="text-cyan">{TIMELINE_LABELS[entry.type] ?? entry.type}</span>
              <p className="text-primary">{entry.summary}</p>
              <p className="text-tertiary">
                {entry.actor ? `${entry.actor} · ` : ""}
                {new Date(entry.timestamp).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* Disposition history */}
      {contact.dispositions.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-primary">Disposition history</h3>
          <ul className="flex flex-col gap-2">
            {contact.dispositions.map((d) => (
              <li key={d.id} className="rounded-lg border border-border p-2 text-xs">
                <span className={d.outcome === "DNC" ? "text-danger" : "text-cyan"}>{DISPOSITION_LABELS[d.outcome]}</span>
                {d.note && <span className="text-secondary"> — {d.note}</span>}
                <p className="text-tertiary">{d.agent.name} · {new Date(d.createdAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
