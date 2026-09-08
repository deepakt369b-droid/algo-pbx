"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui";

// Search-as-you-type pickers shared across the CRM boards (pipeline, tasks).
// Extracted out of pipeline-board.tsx (owner-page enchanted-sphinx plan, W4)
// so the new task-creation dialog can reuse the exact same contact search
// instead of re-implementing it.

export type ContactRef = { id: string; displayName: string | null; numberE164: string };
export type CompanyRef = { id: string; name: string; domain: string | null };

interface SearchPickerProps<T> {
  url: string;
  value: T | null;
  onChange: (value: T | null) => void;
  renderLabel: (item: T) => { primary: string; secondary?: string | null };
  placeholder: string;
  inputId?: string;
  resultsKey: string;
}

function useDebouncedSearch<T>(url: string, resultsKey: string, query: string): T[] {
  const [results, setResults] = useState<T[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`${url}${url.includes("?") ? "&" : "?"}q=${encodeURIComponent(q)}&limit=8`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data) => setResults(data[resultsKey] ?? []))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [url, resultsKey, query]);
  return results;
}

function SearchPicker<T extends { id: string }>({
  url,
  value,
  onChange,
  renderLabel,
  placeholder,
  inputId,
  resultsKey,
}: SearchPickerProps<T>) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useDebouncedSearch<T>(url, resultsKey, query);

  if (value) {
    const label = renderLabel(value);
    return (
      <div className="flex items-center justify-between rounded-[var(--radius)] border bg-surface px-3 py-2 text-sm [border-color:rgb(var(--hairline))]">
        <span className="truncate text-primary">
          {label.primary}
          {label.secondary && <span className="ml-1.5 text-[11px] text-tertiary">{label.secondary}</span>}
        </span>
        <button type="button" aria-label="Clear" className="text-tertiary hover:text-danger" onClick={() => onChange(null)}>
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        id={inputId}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
      />
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-[var(--radius)] border bg-surface shadow-xl [border-color:rgb(var(--hairline))]">
          {results.map((item) => {
            const label = renderLabel(item);
            return (
              <button
                key={item.id}
                type="button"
                className="block w-full truncate px-3 py-2 text-left text-sm text-primary hover:bg-canvas"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(item);
                  setQuery("");
                  setOpen(false);
                }}
              >
                {label.primary}
                {label.secondary && <span className="ml-1.5 text-[11px] text-tertiary">{label.secondary}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// `apiBase` is "/api/admin/crm" or "/api/agent/crm" — the agent contact
// search lives under that same prefix (/api/agent/crm/contacts), but the
// admin one doesn't (/api/admin/contacts, not /api/admin/crm/contacts)
// since it predates the CRM API namespace, hence the branch below.
export function ContactPicker({
  apiBase,
  value,
  onChange,
  inputId,
}: {
  apiBase: string;
  value: ContactRef | null;
  onChange: (contact: ContactRef | null) => void;
  inputId?: string;
}) {
  const contactsUrl = apiBase.includes("/admin/") ? "/api/admin/contacts" : "/api/agent/crm/contacts";
  return (
    <SearchPicker<ContactRef>
      url={contactsUrl}
      resultsKey="contacts"
      value={value}
      onChange={onChange}
      inputId={inputId}
      placeholder="Search contacts by name or number..."
      renderLabel={(c) => ({ primary: c.displayName || c.numberE164, secondary: c.displayName ? c.numberE164 : null })}
    />
  );
}

// Company search — GET /api/admin/crm/companies?q= (staff-only; the agent
// plane has no company search endpoint, so this picker is admin-only by
// construction, matching requirement D1's scope).
export function CompanyPicker({
  value,
  onChange,
  inputId,
}: {
  value: CompanyRef | null;
  onChange: (company: CompanyRef | null) => void;
  inputId?: string;
}) {
  return (
    <SearchPicker<CompanyRef>
      url="/api/admin/crm/companies"
      resultsKey="companies"
      value={value}
      onChange={onChange}
      inputId={inputId}
      placeholder="Search companies by name or domain..."
      renderLabel={(c) => ({ primary: c.name, secondary: c.domain })}
    />
  );
}
