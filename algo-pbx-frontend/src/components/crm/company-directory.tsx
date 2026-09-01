"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Skeleton,
  Dialog,
  Input,
  Label,
} from "@/components/ui";
import { cn } from "@/lib/utils";

type CompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  phone: string | null;
  contactCount: number;
  dealCount: number;
};
type CompanyDetail = {
  id: string;
  name: string;
  domain: string | null;
  phone: string | null;
  address: string | null;
  owner: { id: string; name: string | null } | null;
  contacts: { id: string; displayName: string | null; numberE164: string; email: string | null }[];
  deals: {
    id: string;
    name: string;
    value: number;
    currency: string;
    stage: { id: string; name: string; isWon: boolean; isLost: boolean };
    owner: { id: string; name: string | null } | null;
  }[];
};

export function CompanyDirectory() {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", domain: "", phone: "", address: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    const t = setTimeout(() => setSlow(true), 400);
    fetch("/api/admin/crm/companies", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        setRows(data.companies ?? []);
        setError(null);
      })
      .catch(() => setError("Could not load companies."))
      .finally(() => {
        clearTimeout(t);
        setSlow(false);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetail(null);
    fetch(`/api/admin/crm/companies/${selectedId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((data) => setDetail(data.company))
      .catch(() => setError("Could not load that company."));
  }, [selectedId]);

  const create = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/crm/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          domain: form.domain.trim() || null,
          phone: form.phone.trim() || null,
          address: form.address.trim() || null,
        }),
      });
      if (!res.ok) throw new Error();
      setForm({ name: "", domain: "", phone: "", address: "" });
      setShowCreate(false);
      load();
    } catch {
      setError("Could not create the company.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex w-full flex-col gap-2 lg:w-96 lg:shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-[15px] font-semibold text-primary">Companies</h1>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={15} /> New
          </Button>
        </div>
        {error && <p className="text-[13px] text-danger">{error}</p>}
        {loading && slow ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="rounded-[var(--radius-lg)] border p-6 text-center text-[13px] text-tertiary [border-color:rgb(var(--hairline))]">
            No companies yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    "w-full rounded-[var(--radius)] px-3 py-2 text-left text-sm transition-colors hover:bg-surface-hover",
                    selectedId === c.id ? "bg-accent-subtle text-accent" : "text-primary",
                  )}
                >
                  <div className="font-medium">{c.name}</div>
                  <div className="mt-0.5 flex gap-2 text-[11px] text-tertiary">
                    {c.domain && <span>{c.domain}</span>}
                    <span>{c.contactCount} contacts</span>
                    <span>{c.dealCount} deals</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!selectedId ? (
          <Card>
            <CardContent className="text-center text-[13px] text-tertiary">
              Select a company to see its contacts and deals.
            </CardContent>
          </Card>
        ) : !detail ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>{detail.name}</CardTitle>
                <div className="flex flex-wrap gap-2 text-[12px] text-tertiary">
                  {detail.domain && <span>{detail.domain}</span>}
                  {detail.phone && <span>{detail.phone}</span>}
                  {detail.address && <span>{detail.address}</span>}
                  {detail.owner?.name && <span>Owner: {detail.owner.name}</span>}
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Contacts ({detail.contacts.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {detail.contacts.length === 0 ? (
                  <p className="text-[13px] text-tertiary">No contacts linked.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {detail.contacts.map((ct) => (
                      <li key={ct.id} className="flex items-center justify-between gap-2">
                        <Link href={`/admin/contacts?focus=${ct.id}`} className="text-accent hover:underline">
                          {ct.displayName || ct.numberE164}
                        </Link>
                        <span className="text-[12px] text-tertiary">{ct.email ?? ct.numberE164}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Deals ({detail.deals.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {detail.deals.length === 0 ? (
                  <p className="text-[13px] text-tertiary">No deals.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {detail.deals.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2">
                        <span className="text-primary">{d.name}</span>
                        <span className="flex items-center gap-2 text-[12px] text-tertiary">
                          <Badge tone={d.stage.isWon ? "success" : d.stage.isLost ? "danger" : "neutral"}>
                            {d.stage.name}
                          </Badge>
                          {d.currency} {d.value.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="New company">
        <div className="flex flex-col gap-3">
          {(["name", "domain", "phone", "address"] as const).map((k) => (
            <div key={k}>
              <Label htmlFor={`co-${k}`} className="capitalize">
                {k}
              </Label>
              <Input
                id={`co-${k}`}
                value={form[k]}
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              />
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={saving || !form.name.trim()}>
              {saving ? "Creating…" : "Create"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
