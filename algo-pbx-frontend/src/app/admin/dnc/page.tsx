"use client";

import { useEffect, useRef, useState } from "react";

interface DncEntry {
  id: string;
  numberE164: string;
  reason: string | null;
  source: string;
  createdAt: string;
  addedBy: { name: string } | null;
}

// Countries worth surfacing by default in the picker — every agent seat is
// India-based and the GSM trunk is UAE, so those two cover the common case;
// "Other" reveals a free-text ISO-2 input for anything else
// libphonenumber-js supports rather than hardcoding all ~245 of them into
// a dropdown (see src/lib/phone-normalize.ts's DEFAULT_COUNTRY comment).
const COMMON_COUNTRIES: { code: string; label: string }[] = [
  { code: "IN", label: "India (IN)" },
  { code: "AE", label: "UAE (AE)" },
];

interface PreviewResult {
  hasHeader: boolean;
  phoneColumnIndex: number;
  columns: string[];
  sampleRows: string[][];
  total: number;
  validCount: number;
  invalidCount: number;
  duplicatesInFile: number;
  invalidSample: string[];
}

interface CommitResult {
  imported: number;
  submittedValid: number;
  alreadyOnList: number;
  invalidCount: number;
  duplicatesInFile: number;
  rejectedCsv: string | null;
}

export default function DncPage() {
  const [entries, setEntries] = useState<DncEntry[]>([]);
  const [number, setNumber] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // Bulk import state — a paste-text fallback and a drag-drop file both
  // feed the same preview-then-commit flow (structural inspiration: the
  // preview-before-commit shape in marmelab/atomic-crm's contact-import,
  // adapted here to plain Tailwind/fetch, no MUI, no library copied).
  const [bulkText, setBulkText] = useState("");
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [bulkCountry, setBulkCountry] = useState("IN");
  const [customCountry, setCustomCountry] = useState("");
  const [bulkReason, setBulkReason] = useState("");
  const [hasHeaderOverride, setHasHeaderOverride] = useState<boolean | null>(null);
  const [phoneColumnOverride, setPhoneColumnOverride] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const effectiveCountry = bulkCountry === "OTHER" ? customCountry.toUpperCase() : bulkCountry;

  const buildBulkForm = (mode: "preview" | "commit") => {
    const form = new FormData();
    form.set("mode", mode);
    form.set("defaultCountry", effectiveCountry);
    if (bulkReason) form.set("reason", bulkReason);
    if (hasHeaderOverride !== null) form.set("hasHeader", String(hasHeaderOverride));
    if (phoneColumnOverride !== null) form.set("phoneColumnIndex", String(phoneColumnOverride));
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
      const res = await fetch("/api/dnc/bulk-import", { method: "POST", body: buildBulkForm("preview") });
      const data = await res.json();
      if (!res.ok) {
        setBulkError(typeof data.error === "string" ? data.error : "Could not parse the import.");
        return;
      }
      setPreview(data);
      setHasHeaderOverride(data.hasHeader);
      setPhoneColumnOverride(data.phoneColumnIndex);
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
      const res = await fetch("/api/dnc/bulk-import", { method: "POST", body: buildBulkForm("commit") });
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
    a.download = "dnc-import-rejected.csv";
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

  const load = () => {
    fetch("/api/dnc")
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        setEntries(data.entries ?? []);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load the DNC list."));
  };

  useEffect(load, []);

  const add = async () => {
    setMessage(null);
    const res = await fetch("/api/dnc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, reason: reason || undefined }),
    });
    const data = await res.json();
    if (res.ok) {
      setNumber("");
      setReason("");
      setMessage(`${number} added to the Do Not Call list.`);
      load();
    } else {
      setMessage(`Failed: ${data.error ?? "unknown error"}`);
    }
  };

  const remove = async (id: string, label: string) => {
    try {
      const res = await fetch(`/api/dnc/${id}`, { method: "DELETE" });
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
      <h1 className="text-xl font-semibold text-primary">Do Not Call List</h1>
      <p className="max-w-md text-center text-xs text-tertiary">
        Blocks outbound dialing to these numbers from the softphone (immediate UX feedback) and,
        separately, at the Asterisk dialplan level (the enforcement that actually matters —
        see pbx_configs/func_odbc.conf).
      </p>

      {loadError && (
        <div className="w-full max-w-md rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
          {loadError}
        </div>
      )}

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Add a number</h2>
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="Phone number, e.g. 050 123 4567 or +14155552671"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button onClick={add} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg">
          Add
        </button>
      </div>

      <div className="glass-card flex w-full max-w-lg flex-col gap-3 p-6">
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
            <span>Drag a CSV or XLSX file here, or click to browse</span>
          )}
        </div>

        <p className="text-center text-xs text-tertiary">— or paste numbers below —</p>

        <textarea
          value={bulkText}
          onChange={(e) => {
            setBulkText(e.target.value);
            setBulkFile(null);
            setPreview(null);
            setCommitResult(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
          placeholder={"One number per line, e.g.:\n+971501234567\n9876543210"}
          rows={4}
          disabled={!!bulkFile}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan disabled:opacity-40"
        />

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex flex-col gap-1 text-xs text-secondary">
            Country for bare (non-+) numbers
            <select
              value={bulkCountry}
              onChange={(e) => setBulkCountry(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            >
              {COMMON_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
              <option value="OTHER">Other (ISO code)…</option>
            </select>
          </label>
          {bulkCountry === "OTHER" && (
            <input
              value={customCountry}
              onChange={(e) => setCustomCountry(e.target.value.slice(0, 2))}
              placeholder="e.g. US"
              maxLength={2}
              className="mt-5 w-16 rounded-lg border border-border bg-background px-2 py-2 text-sm uppercase outline-none focus:border-cyan"
            />
          )}
        </div>

        <input
          value={bulkReason}
          onChange={(e) => setBulkReason(e.target.value)}
          placeholder="Reason applied to the whole batch (optional)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />

        {bulkError && <p className="text-xs text-danger">{bulkError}</p>}

        {!preview && !commitResult && (
          <button
            onClick={runPreview}
            disabled={bulkBusy || (bulkCountry === "OTHER" && customCountry.length !== 2)}
            className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-primary disabled:opacity-50"
          >
            {bulkBusy ? "Parsing…" : "Preview import"}
          </button>
        )}

        {preview && (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-background/40 p-3 text-xs text-secondary">
            <p className="font-semibold text-primary">Preview — nothing has been imported yet</p>

            {preview.columns.length > 1 && (
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
                  Sample of unparseable values ({preview.invalidSample.length}{preview.invalidCount > preview.invalidSample.length ? "+" : ""})
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
                {bulkBusy ? "Importing…" : `Import ${preview.validCount} number${preview.validCount === 1 ? "" : "s"}`}
              </button>
              <button
                onClick={() => {
                  setPreview(null);
                  setHasHeaderOverride(null);
                  setPhoneColumnOverride(null);
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
              Imported {commitResult.imported} number{commitResult.imported === 1 ? "" : "s"}.
              {commitResult.alreadyOnList > 0 && ` ${commitResult.alreadyOnList} were already on the list.`}
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

        {message && <p className="text-xs text-tertiary">{message}</p>}
      </div>

      <div className="glass-card w-full max-w-md p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">
          Blocked Numbers ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <p className="text-tertiary">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-primary">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between border-t border-border pt-2 first:border-0 first:pt-0">
                <div>
                  <p>{e.numberE164}</p>
                  {e.reason && <p className="text-xs text-tertiary">{e.reason}</p>}
                </div>
                {confirmRemoveId === e.id ? (
                  <span className="flex items-center gap-2 text-xs">
                    <button onClick={() => remove(e.id, e.numberE164)} className="text-danger hover:text-danger">
                      Confirm
                    </button>
                    <button onClick={() => setConfirmRemoveId(null)} className="text-tertiary">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmRemoveId(e.id)} className="text-xs text-danger hover:text-danger">
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
