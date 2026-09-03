"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@/components/ui";
import { COUNTRY_OPTIONS } from "@/lib/countries";

interface Contact {
  id: string;
  numberE164: string;
  displayName: string | null;
  email: string | null;
  company: string | null;
  companyId: string | null;
  companyRel: { id: string; name: string } | null;
  dealCount: number;
  tags: string[];
  ownerId: string | null;
  owner: { id: string; name: string; extension: { number: string } | null } | null;
  updatedAt: string;
}

interface AgentOption {
  id: string;
  name: string;
  disabled: boolean;
  role: "AGENT" | "SUPERVISOR" | "ADMIN";
  extension: { number: string } | null;
}

interface PreviewResult {
  hasHeader: boolean;
  phoneColumnIndex: number;
  nameColumnIndex: number | null;
  columns: string[];
  total: number;
  validCount: number;
  invalidCount: number;
  duplicatesInFile: number;
  invalidSample: string[];
}

interface CommitResult {
  imported: number;
  submittedValid: number;
  alreadyExisted: number;
  invalidCount: number;
  duplicatesInFile: number;
  rejectedCsv: string | null;
}

// Empty form shape shared by create and edit — the same <ContactForm/> body
// is reused for both (task requirement: "same form for create and edit"),
// only the submit handler and initial values differ.
interface FormState {
  number: string;
  country: string;
  displayName: string;
  email: string;
  company: string;
  companyId: string;
  tagsInput: string;
  ownerId: string;
  initialNote: string;
}

const EMPTY_FORM: FormState = {
  number: "",
  country: "IN",
  displayName: "",
  email: "",
  company: "",
  companyId: "",
  tagsInput: "",
  ownerId: "",
  initialNote: "",
};

function parseTags(input: string): string[] {
  return Array.from(new Set(input.split(",").map((t) => t.trim()).filter(Boolean)));
}

// Structural inspiration only (per task instructions): marmelab/atomic-crm's
// contact list/form/ownership-badge layout — no MUI/React code copied, this
// stays this codebase's plain Tailwind `glass-card` convention throughout.
export default function ContactsAdminPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [companies, setCompanies] = useState<{ id: string; name: string; domain: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState(""); // "" = all, "unassigned" = null-owner
  const [tagFilter, setTagFilter] = useState("");
  const [limit, setLimit] = useState(100);

  // Create/edit form — editingId null means "create mode".
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<Contact | null>(null);

  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // Merge: pick a loser row's "Merge" action, then search for the winner
  // to merge it into.
  const [mergeLoserId, setMergeLoserId] = useState<string | null>(null);
  const [mergeQuery, setMergeQuery] = useState("");
  const [mergeResults, setMergeResults] = useState<Contact[]>([]);
  const [mergeBusy, setMergeBusy] = useState(false);

  // Bulk import — same preview-then-commit flow as /admin/dnc's bulk import.
  const [showImport, setShowImport] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [bulkCountry, setBulkCountry] = useState("IN");
  const [bulkOwnerId, setBulkOwnerId] = useState("");
  const [hasHeaderOverride, setHasHeaderOverride] = useState<boolean | null>(null);
  const [phoneColumnOverride, setPhoneColumnOverride] = useState<number | null>(null);
  const [nameColumnOverride, setNameColumnOverride] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ADMIN is never a contact owner — it administers and allocates contacts
  // to real agents/supervisors, it doesn't work them itself (operator
  // requirement). Excluded here rather than just in this one picker so
  // every owner-assignment surface in this file (single-add, bulk-import
  // batch owner, the list's owner filter) stays consistent automatically.
  const activeAgents = useMemo(() => agents.filter((a) => !a.disabled && a.role !== "ADMIN"), [agents]);
  const allTags = useMemo(() => Array.from(new Set(contacts.flatMap((c) => c.tags))).sort(), [contacts]);

  const load = (opts?: { q?: string; owner?: string; tag?: string; limit?: number }) => {
    setLoading(true);
    const params = new URLSearchParams();
    const q = opts?.q ?? query;
    const owner = opts?.owner ?? ownerFilter;
    const tag = opts?.tag ?? tagFilter;
    const lim = opts?.limit ?? limit;
    if (q) params.set("q", q);
    if (owner !== "") params.set("owner", owner === "unassigned" ? "" : owner);
    if (tag) params.set("tag", tag);
    params.set("limit", String(lim));
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

  useEffect(() => {
    load();
    fetch("/api/admin/users", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((data) => setAgents(data.users ?? []))
      .catch(() => setAgents([]));
    fetch("/api/admin/crm/companies", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { companies: [] }))
      .then((data) => setCompanies(data.companies ?? []))
      .catch(() => setCompanies([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = () => load();
  const resetFilters = () => {
    setQuery("");
    setOwnerFilter("");
    setTagFilter("");
    load({ q: "", owner: "", tag: "" });
  };
  const loadMore = () => {
    const next = limit + 100;
    setLimit(next);
    load({ limit: next });
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setDuplicateOf(null);
    setShowForm(true);
  };

  const openEdit = (c: Contact) => {
    setEditingId(c.id);
    setForm({
      number: c.numberE164,
      country: "IN",
      displayName: c.displayName ?? "",
      email: c.email ?? "",
      company: c.company ?? "",
      companyId: c.companyId ?? "",
      tagsInput: c.tags.join(", "),
      ownerId: c.ownerId ?? "",
      initialNote: "",
    });
    setFormError(null);
    setDuplicateOf(null);
    setShowForm(true);
  };

  const submitForm = async () => {
    setFormError(null);
    setDuplicateOf(null);
    if (!form.displayName.trim()) {
      setFormError("Name is required.");
      return;
    }
    setSaving(true);
    try {
      const isEdit = editingId !== null;
      const url = isEdit ? `/api/admin/contacts/${editingId}` : "/api/admin/contacts";
      const body: Record<string, unknown> = {
        number: form.number,
        country: form.country,
        displayName: form.displayName.trim(),
        email: form.email.trim(),
        company: form.company.trim() || null,
        companyId: form.companyId || null,
        tags: parseTags(form.tagsInput),
        ownerId: form.ownerId || null,
      };
      if (!isEdit && form.initialNote.trim()) body.initialNote = form.initialNote.trim();

      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setShowForm(false);
        setMessage(`${data.contact.displayName ?? data.contact.numberE164} ${isEdit ? "updated" : "added"}.`);
        load();
      } else if (res.status === 409 && data.existingContact) {
        setDuplicateOf(data.existingContact);
        setFormError(data.error ?? "A contact with this number already exists.");
      } else {
        setFormError(data.error ?? "Something went wrong.");
      }
    } catch {
      setFormError("Could not reach the server.");
    } finally {
      setSaving(false);
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
      load();
    } finally {
      setConfirmRemoveId(null);
    }
  };

  const openMerge = (loserId: string) => {
    setMergeLoserId(loserId);
    setMergeQuery("");
    setMergeResults([]);
  };

  const searchMergeTarget = async () => {
    if (!mergeQuery.trim()) return;
    const params = new URLSearchParams({ q: mergeQuery.trim(), limit: "10" });
    const res = await fetch(`/api/admin/contacts?${params.toString()}`);
    const data = await res.json().catch(() => ({ contacts: [] }));
    setMergeResults((data.contacts ?? []).filter((c: Contact) => c.id !== mergeLoserId));
  };

  const confirmMerge = async (winnerId: string) => {
    if (!mergeLoserId) return;
    setMergeBusy(true);
    try {
      const res = await fetch(`/api/admin/contacts/${winnerId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loserId: mergeLoserId }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(
          `Merged into ${data.contact.displayName ?? data.contact.numberE164}.` +
            (data.droppedConversations ? ` ${data.droppedConversations} duplicate conversation(s) dropped.` : "")
        );
        setMergeLoserId(null);
        load();
      } else {
        setMessage(`Merge failed: ${data.error ?? "unknown error"}`);
      }
    } finally {
      setMergeBusy(false);
    }
  };

  // --- Bulk import ---

  const buildBulkForm = (mode: "preview" | "commit") => {
    const form = new FormData();
    form.set("mode", mode);
    form.set("defaultCountry", bulkCountry);
    if (bulkOwnerId) form.set("ownerId", bulkOwnerId);
    if (hasHeaderOverride !== null) form.set("hasHeader", String(hasHeaderOverride));
    if (phoneColumnOverride !== null) form.set("phoneColumnIndex", String(phoneColumnOverride));
    if (nameColumnOverride !== null) form.set("nameColumnIndex", String(nameColumnOverride));
    if (bulkFile) form.set("file", bulkFile);
    else form.set("text", bulkText);
    return form;
  };

  const runPreview = async () => {
    setBulkError(null);
    setCommitResult(null);
    if (!bulkFile && !bulkText.trim()) {
      setBulkError("Upload a CSV/XLSX file or paste some numbers first.");
      return;
    }
    setBulkBusy(true);
    try {
      const res = await fetch("/api/admin/contacts/bulk-import", { method: "POST", body: buildBulkForm("preview") });
      const data = await res.json();
      if (!res.ok) {
        setBulkError(typeof data.error === "string" ? data.error : "Could not parse the import.");
        return;
      }
      setPreview(data);
      setHasHeaderOverride(data.hasHeader);
      setPhoneColumnOverride(data.phoneColumnIndex);
      setNameColumnOverride(data.nameColumnIndex);
    } catch {
      setBulkError("Could not reach the server.");
    } finally {
      setBulkBusy(false);
    }
  };

  const runCommit = async () => {
    if (!preview) return;
    setBulkError(null);
    setBulkBusy(true);
    try {
      const res = await fetch("/api/admin/contacts/bulk-import", { method: "POST", body: buildBulkForm("commit") });
      const data = await res.json();
      if (!res.ok) {
        setBulkError(typeof data.error === "string" ? data.error : "Import failed.");
        return;
      }
      setCommitResult(data);
      setPreview(null);
      setBulkText("");
      setBulkFile(null);
      setHasHeaderOverride(null);
      setPhoneColumnOverride(null);
      setNameColumnOverride(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      load();
    } catch {
      setBulkError("Could not reach the server.");
    } finally {
      setBulkBusy(false);
    }
  };

  const downloadRejected = () => {
    if (!commitResult?.rejectedCsv) return;
    const blob = new Blob([commitResult.rejectedCsv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts-import-rejected.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      setBulkFile(dropped);
      setBulkText("");
      setPreview(null);
      setCommitResult(null);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Contacts</h1>
      <p className="max-w-2xl text-center text-xs text-tertiary">
        The CRM contact directory — owner, tags, notes, and history for every phone number. Every
        other messaging surface (conversation-list.tsx, admin/sms/page.tsx) reads
        <code className="mx-1 text-secondary">contact.displayName ?? contact.numberE164</code>
        off this same table.
      </p>

      {loadError && (
        <div className="w-full max-w-4xl rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
          {loadError}
        </div>
      )}
      {message && (
        <div className="w-full max-w-4xl rounded-lg border border-cyan/30 bg-cyan/5 px-4 py-2 text-center text-xs text-secondary">
          {message}
          <button onClick={() => setMessage(null)} className="ml-3 text-tertiary hover:text-primary">
            dismiss
          </button>
        </div>
      )}

      <div className="flex w-full max-w-5xl flex-wrap gap-2">
        <button onClick={openCreate} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg">
          Add contact
        </button>
        <button
          onClick={() => setShowImport((v) => !v)}
          className="rounded-lg border border-border px-4 py-2 text-sm text-secondary hover:border-cyan"
        >
          {showImport ? "Hide bulk import" : "Bulk import"}
        </button>
      </div>

      {/* --- Create/edit form --- */}
      {showForm && (
        <div className="glass-card flex w-full max-w-5xl flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
            {editingId ? "Edit contact" : "Add a contact"}
          </h2>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-secondary">
              Name *
              <input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="e.g. Asha Rao"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
              />
            </label>

            <div className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1 text-xs text-secondary">
                Phone number *
                <input
                  value={form.number}
                  onChange={(e) => setForm({ ...form, number: e.target.value })}
                  placeholder="050 123 4567 or +14155552671"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
                />
              </label>
              <label className="flex w-40 flex-col gap-1 text-xs text-secondary">
                Country
                <Combobox
                  aria-label="Country"
                  value={form.country}
                  onChange={(v) => setForm({ ...form, country: v ?? "IN" })}
                  options={COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: c.label }))}
                  placeholder="Search countries…"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-xs text-secondary">
              Email
              <input
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="optional"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-secondary">
              Company (free text)
              <input
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
                placeholder="optional"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
              />
            </label>

            <div className="flex flex-col gap-1 text-xs text-secondary">
              Link to company record
              <Combobox
                aria-label="Link to company"
                value={form.companyId || null}
                onChange={(v) => setForm({ ...form, companyId: v ?? "" })}
                options={companies.map((co) => ({
                  value: co.id,
                  label: co.name,
                  hint: co.domain ?? undefined,
                }))}
                placeholder="Search companies…"
              />
              {form.companyId && (
                <button
                  type="button"
                  onClick={() => setForm({ ...form, companyId: "" })}
                  className="w-fit text-[11px] text-tertiary hover:text-primary"
                >
                  Clear link
                </button>
              )}
            </div>

            <label className="flex flex-col gap-1 text-xs text-secondary">
              Tags (comma-separated)
              <input
                value={form.tagsInput}
                onChange={(e) => setForm({ ...form, tagsInput: e.target.value })}
                placeholder="e.g. vip, renewal"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-secondary">
              Owner
              <select
                value={form.ownerId}
                onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
              >
                <option value="">Unassigned</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.extension ? ` (ext. ${a.extension.number})` : ""}
                  </option>
                ))}
              </select>
            </label>

            {!editingId && (
              <label className="flex flex-col gap-1 text-xs text-secondary sm:col-span-2">
                Initial note (optional)
                <textarea
                  value={form.initialNote}
                  onChange={(e) => setForm({ ...form, initialNote: e.target.value })}
                  rows={2}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
                />
              </label>
            )}
          </div>

          {formError && (
            <div className="rounded-lg border border-danger/40 bg-danger-subtle px-3 py-2 text-xs text-danger">
              {formError}
              {duplicateOf && (
                <button
                  onClick={() => {
                    setShowForm(false);
                    setEditingId(duplicateOf.id);
                    openEdit(duplicateOf);
                  }}
                  className="ml-2 text-cyan hover:underline"
                >
                  Edit the existing contact instead
                </button>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={submitForm}
              disabled={saving}
              className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {saving ? "Saving…" : editingId ? "Save changes" : "Add contact"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-border px-4 py-2 text-sm text-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* --- Bulk import --- */}
      {showImport && (
        <div className="glass-card flex w-full max-w-5xl flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Bulk import</h2>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center text-xs transition-colors ${
              dragActive ? "border-cyan bg-cyan/5" : "border-border text-tertiary"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setBulkFile(f);
                  setBulkText("");
                  setPreview(null);
                  setCommitResult(null);
                }
              }}
            />
            {bulkFile ? (
              <span className="text-primary">
                {bulkFile.name}{" "}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setBulkFile(null);
                    setPreview(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="text-danger hover:text-danger"
                >
                  remove
                </button>
              </span>
            ) : (
              <span>Drag a CSV or XLSX file here (name + phone columns), or click to browse</span>
            )}
          </div>

          <p className="text-center text-xs text-tertiary">— or paste &quot;name, phone&quot; lines below —</p>

          <textarea
            value={bulkText}
            onChange={(e) => {
              setBulkText(e.target.value);
              setBulkFile(null);
              setPreview(null);
              setCommitResult(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            placeholder={"name,number\nAsha Rao,9876543210\nVikram Shah,9123456780"}
            rows={4}
            disabled={!!bulkFile}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan disabled:opacity-40"
          />

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex w-56 flex-col gap-1 text-xs text-secondary">
              Country for bare (non-+) numbers
              <Combobox
                aria-label="Country for bare numbers"
                value={bulkCountry}
                onChange={(v) => setBulkCountry(v ?? "IN")}
                options={COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: c.label }))}
                placeholder="Search countries…"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-secondary">
              Owner for the whole batch
              <select
                value={bulkOwnerId}
                onChange={(e) => setBulkOwnerId(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
              >
                <option value="">Unassigned</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {bulkError && <p className="text-xs text-danger">{bulkError}</p>}

          {!preview && !commitResult && (
            <button
              onClick={runPreview}
              disabled={bulkBusy}
              className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-primary disabled:opacity-50"
            >
              {bulkBusy ? "Parsing…" : "Preview import"}
            </button>
          )}

          {preview && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-background/40 p-3 text-xs text-secondary">
              <p className="font-semibold text-primary">Preview — nothing has been imported yet</p>

              {preview.columns.length > 1 && (
                <div className="flex flex-wrap gap-3">
                  <label className="flex flex-col gap-1">
                    Phone column
                    <select
                      value={phoneColumnOverride ?? preview.phoneColumnIndex}
                      onChange={(e) => setPhoneColumnOverride(Number(e.target.value))}
                      className="rounded-lg border border-border bg-background px-2 py-1 outline-none focus:border-cyan"
                    >
                      {preview.columns.map((col, i) => (
                        <option key={i} value={i}>
                          {preview.hasHeader && col ? col : `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    Name column
                    <select
                      value={nameColumnOverride ?? preview.nameColumnIndex ?? -1}
                      onChange={(e) => setNameColumnOverride(Number(e.target.value))}
                      className="rounded-lg border border-border bg-background px-2 py-1 outline-none focus:border-cyan"
                    >
                      <option value={-1}>None</option>
                      {preview.columns.map((col, i) => (
                        <option key={i} value={i}>
                          {preview.hasHeader && col ? col : `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={hasHeaderOverride ?? preview.hasHeader}
                  onChange={(e) => setHasHeaderOverride(e.target.checked)}
                />
                First row is a header (skip it)
              </label>

              <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                <li>Total rows: {preview.total}</li>
                <li className="text-cyan">Valid: {preview.validCount}</li>
                <li className="text-danger">Invalid: {preview.invalidCount}</li>
                <li>Duplicates in file: {preview.duplicatesInFile}</li>
              </ul>

              {preview.invalidSample.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-secondary">
                    Sample of unparseable values ({preview.invalidSample.length}
                    {preview.invalidCount > preview.invalidSample.length ? "+" : ""})
                  </summary>
                  <p className="mt-1 break-all text-tertiary">{preview.invalidSample.join(", ")}</p>
                </details>
              )}

              <div className="flex gap-2">
                <button
                  onClick={runCommit}
                  disabled={bulkBusy || preview.validCount === 0}
                  className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
                >
                  {bulkBusy ? "Importing…" : `Import ${preview.validCount} contact${preview.validCount === 1 ? "" : "s"}`}
                </button>
                <button
                  onClick={() => {
                    setPreview(null);
                    setHasHeaderOverride(null);
                    setPhoneColumnOverride(null);
                    setNameColumnOverride(null);
                  }}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {commitResult && (
            <div className="flex flex-col gap-2 rounded-lg border border-cyan/30 bg-cyan/5 p-3 text-xs text-secondary">
              <p>
                Imported {commitResult.imported} contact{commitResult.imported === 1 ? "" : "s"}.
                {commitResult.alreadyExisted > 0 && ` ${commitResult.alreadyExisted} already existed and were skipped.`}
                {commitResult.invalidCount > 0 && ` ${commitResult.invalidCount} could not be parsed.`}
              </p>
              {commitResult.rejectedCsv && (
                <button onClick={downloadRejected} className="self-start text-cyan hover:underline">
                  Download rejected rows (CSV)
                </button>
              )}
              <button onClick={() => setCommitResult(null)} className="self-start text-tertiary hover:text-primary">
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {/* --- Search / filter bar --- */}
      <div className="glass-card w-full max-w-5xl p-6">
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-tertiary">
            Search
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, number, or company"
              className="w-56 rounded border border-border bg-background px-2 py-1 text-sm text-primary outline-none focus:border-cyan"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-tertiary">
            Owner
            <select
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1 text-sm text-primary outline-none focus:border-cyan"
            >
              <option value="">All</option>
              <option value="unassigned">Unassigned</option>
              {activeAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-tertiary">
            Tag
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1 text-sm text-primary outline-none focus:border-cyan"
            >
              <option value="">All</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button onClick={applyFilters} className="rounded bg-cyan px-3 py-1.5 text-xs font-medium text-accent-fg">
            Apply
          </button>
          <button onClick={resetFilters} className="text-xs text-secondary hover:text-primary">
            Reset
          </button>
        </div>

        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">
          Contacts ({contacts.length})
        </h2>
        {loading && <p className="text-tertiary">Loading contacts…</p>}
        {!loading && contacts.length === 0 && <p className="text-tertiary">No contacts yet.</p>}
        {!loading && contacts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-secondary">
              <thead>
                <tr className="border-b border-border text-tertiary">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Number</th>
                  <th className="pb-2 pr-3">Company</th>
                  <th className="pb-2 pr-3">Deals</th>
                  <th className="pb-2 pr-3">Owner</th>
                  <th className="pb-2 pr-3">Tags</th>
                  <th className="pb-2 pr-3">Last activity</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-b border-border/50">
                    <td className="py-2 pr-3 text-primary">{c.displayName ?? <span className="text-tertiary">—</span>}</td>
                    <td className="py-2 pr-3 font-mono text-secondary">{c.numberE164}</td>
                    <td className="py-2 pr-3">
                      {c.companyRel?.name ?? c.company ?? <span className="text-tertiary">—</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {c.dealCount > 0 ? c.dealCount : <span className="text-tertiary">—</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {c.owner ? (
                        <span>
                          {c.owner.name}
                          {c.owner.extension ? <span className="text-tertiary"> (ext. {c.owner.extension.number})</span> : null}
                        </span>
                      ) : (
                        <span className="text-tertiary">Unassigned</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {c.tags.length ? (
                        <div className="flex flex-wrap gap-1">
                          {c.tags.map((t) => (
                            <span key={t} className="rounded-full border border-cyan/30 bg-cyan/5 px-2 py-0.5 text-[10px] text-cyan">
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-tertiary">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-tertiary">{new Date(c.updatedAt).toLocaleString()}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button onClick={() => openEdit(c)} className="text-cyan hover:text-cyan/80">
                          Edit
                        </button>
                        <button onClick={() => openMerge(c.id)} className="text-secondary hover:text-primary">
                          Merge
                        </button>
                        {confirmRemoveId === c.id ? (
                          <span className="flex items-center gap-2">
                            <button onClick={() => remove(c.id, c.displayName ?? c.numberE164)} className="text-danger hover:text-danger">
                              Confirm
                            </button>
                            <button onClick={() => setConfirmRemoveId(null)} className="text-tertiary">
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button onClick={() => setConfirmRemoveId(c.id)} className="text-danger hover:text-danger">
                            Remove
                          </button>
                        )}
                      </div>

                      {mergeLoserId === c.id && (
                        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-background/60 p-2">
                          <p className="text-secondary">
                            Merge &quot;{c.displayName ?? c.numberE164}&quot; into another contact:
                          </p>
                          <div className="flex gap-1">
                            <input
                              value={mergeQuery}
                              onChange={(e) => setMergeQuery(e.target.value)}
                              placeholder="Search name or number"
                              className="flex-1 rounded border border-border bg-background px-2 py-1 outline-none focus:border-cyan"
                            />
                            <button onClick={searchMergeTarget} className="rounded bg-cyan px-2 py-1 text-accent-fg">
                              Find
                            </button>
                            <button onClick={() => setMergeLoserId(null)} className="text-tertiary">
                              Cancel
                            </button>
                          </div>
                          {mergeResults.length > 0 && (
                            <ul className="flex flex-col gap-1">
                              {mergeResults.map((r) => (
                                <li key={r.id} className="flex items-center justify-between">
                                  <span>
                                    {r.displayName ?? r.numberE164} <span className="text-tertiary">{r.numberE164}</span>
                                  </span>
                                  <button
                                    onClick={() => confirmMerge(r.id)}
                                    disabled={mergeBusy}
                                    className="text-cyan hover:underline disabled:opacity-50"
                                  >
                                    Merge into this
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {contacts.length >= limit && (
              <div className="mt-3 flex justify-center">
                <button onClick={loadMore} className="text-xs text-cyan hover:underline">
                  Load more
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
