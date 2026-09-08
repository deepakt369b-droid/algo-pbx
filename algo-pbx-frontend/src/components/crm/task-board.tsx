"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Skeleton, Badge, Button, Dialog, Input, Label, Select, Textarea } from "@/components/ui";
import { ContactPicker, type ContactRef } from "@/components/crm/contact-picker";
import { cn } from "@/lib/utils";

type Task = {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignee: { id: string; name: string | null } | null;
  contact: { id: string; displayName: string | null; numberE164: string } | null;
  deal: { id: string; name: string } | null;
};

type AssigneeOption = { id: string; name: string | null; email: string };
type DealOption = { id: string; name: string };

const FILTERS: { key: string; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "today", label: "Due today" },
  { key: "overdue", label: "Overdue" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
];

// Shared task list for /admin/crm/tasks and /agent/crm/tasks. `apiBase` is
// "/api/admin/crm" or "/api/agent/crm". `contactPath` + `contactParam` build
// the link to a contact (admin CRM uses /admin/contacts?focus=, the agent
// CRM uses /agent?contact=) — passed as plain strings, not a function, so a
// Server Component page can render this Client Component directly.
export function TaskBoard({
  apiBase,
  contactPath,
  contactParam,
}: {
  apiBase: string;
  contactPath: string;
  contactParam: string;
}) {
  const isAdminBase = apiBase.includes("/admin/");
  const contactHref = (id: string) => `${contactPath}?${contactParam}=${encodeURIComponent(id)}`;
  const [filter, setFilter] = useState("open");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New-task dialog — admin plane only (owner-page enchanted-sphinx plan,
  // W4: "in task there is no button for the new task"). The agent plane
  // already creates tasks from the contact drawer
  // (src/components/crm/contact-detail.tsx); this button is additive there
  // too, but the assignee/deal pickers below assume staff-only endpoints, so
  // it's gated to admin to avoid the agent board making requests it may not
  // be allowed to see the results of.
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContact, setNewContact] = useState<ContactRef | null>(null);
  const [newAssigneeId, setNewAssigneeId] = useState<string | null>(null);
  const [newDealId, setNewDealId] = useState<string | null>(null);
  const [newDueAt, setNewDueAt] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [assignees, setAssignees] = useState<AssigneeOption[]>([]);
  const [dealOptions, setDealOptions] = useState<DealOption[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isAdminBase) return;
    fetch("/api/admin/users", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => setAssignees(data.users ?? []))
      .catch(() => setAssignees([]));
    fetch(`${apiBase}/pipeline`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => setDealOptions((data.deals ?? []).map((d: { id: string; name: string }) => ({ id: d.id, name: d.name }))))
      .catch(() => setDealOptions([]));
  }, [isAdminBase, apiBase]);

  const load = useCallback(() => {
    const t = setTimeout(() => setSlow(true), 400);
    fetch(`${apiBase}/tasks?filter=${filter}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        setTasks(data.tasks ?? []);
        setError(null);
      })
      .catch(() => setError("Could not load tasks."))
      .finally(() => {
        clearTimeout(t);
        setSlow(false);
        setLoading(false);
      });
  }, [apiBase, filter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const toggle = async (task: Task) => {
    const completed = !task.completedAt;
    setTasks((ts) =>
      ts.map((x) => (x.id === task.id ? { ...x, completedAt: completed ? new Date().toISOString() : null } : x)),
    );
    try {
      const res = await fetch(`${apiBase}/tasks`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, completed }),
      });
      if (!res.ok) throw new Error(String(res.status));
      load();
    } catch {
      setError("Could not update that task.");
      load();
    }
  };

  const createNewTask = async () => {
    if (!newTitle.trim() || !newContact || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`${apiBase}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          contactId: newContact.id,
          assigneeId: newAssigneeId ?? undefined,
          dealId: newDealId ?? undefined,
          dueAt: newDueAt ? new Date(newDueAt).toISOString() : undefined,
          description: newDescription.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? String(res.status));
      setNewTitle("");
      setNewContact(null);
      setNewAssigneeId(null);
      setNewDealId(null);
      setNewDueAt("");
      setNewDescription("");
      setShowCreate(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the task.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-[var(--radius)] border p-0.5 text-[13px] [border-color:rgb(var(--hairline))]">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-[var(--radius-sm)] px-3 py-1.5 transition-colors",
                filter === f.key ? "bg-accent-subtle text-accent" : "text-secondary hover:text-primary",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {isAdminBase && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={15} /> New task
          </Button>
        )}
      </div>

      {error && <p className="text-[13px] text-danger">{error}</p>}

      {loading && slow ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border p-8 text-center text-[13px] text-tertiary [border-color:rgb(var(--hairline))]">
          Nothing here.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((t) => {
            const overdue = !t.completedAt && t.dueAt && new Date(t.dueAt) < new Date();
            return (
              <li
                key={t.id}
                className="flex items-start gap-3 rounded-[var(--radius)] border bg-surface p-3 text-sm [border-color:rgb(var(--hairline))]"
              >
                <input
                  type="checkbox"
                  checked={Boolean(t.completedAt)}
                  onChange={() => toggle(t)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-label={`Mark "${t.title}" complete`}
                />
                <div className="min-w-0 flex-1">
                  <div className={cn("text-primary", t.completedAt && "text-tertiary line-through")}>{t.title}</div>
                  {t.description && <p className="mt-0.5 text-[12px] text-secondary">{t.description}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-tertiary">
                    {t.assignee?.name && <span>{t.assignee.name}</span>}
                    {t.dueAt && (
                      <span className={overdue ? "text-danger" : undefined}>
                        due {new Date(t.dueAt).toLocaleDateString()}
                      </span>
                    )}
                    {t.contact && (
                      <Link href={contactHref(t.contact.id)} className="text-accent hover:underline">
                        {t.contact.displayName || t.contact.numberE164}
                      </Link>
                    )}
                    {t.deal && <Badge tone="neutral">{t.deal.name}</Badge>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {isAdminBase && (
        <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="New task">
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="task-title">Title</Label>
              <Input id="task-title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Follow up call" />
            </div>
            <div>
              <Label htmlFor="task-contact">Contact</Label>
              <ContactPicker apiBase={apiBase} value={newContact} onChange={setNewContact} inputId="task-contact" />
            </div>
            <div>
              <Label htmlFor="task-assignee">Assignee</Label>
              <Select
                aria-label="Assignee"
                value={newAssigneeId}
                onChange={setNewAssigneeId}
                placeholder="Unassigned (defaults to you)"
                options={assignees.map((a) => ({ value: a.id, label: a.name || a.email }))}
              />
            </div>
            <div>
              <Label htmlFor="task-deal">Deal (optional)</Label>
              <Select
                aria-label="Deal"
                value={newDealId}
                onChange={setNewDealId}
                placeholder="No deal"
                options={dealOptions.map((d) => ({ value: d.id, label: d.name }))}
              />
            </div>
            <div>
              <Label htmlFor="task-due">Due date</Label>
              <Input id="task-due" type="date" value={newDueAt} onChange={(e) => setNewDueAt(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="task-description">Notes / description</Label>
              <Textarea
                id="task-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                rows={3}
                placeholder="Optional context for whoever picks this up"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowCreate(false);
                  setNewContact(null);
                }}
              >
                Cancel
              </Button>
              <Button onClick={createNewTask} disabled={creating || !newTitle.trim() || !newContact}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
