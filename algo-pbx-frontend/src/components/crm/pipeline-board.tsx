"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Plus, X } from "lucide-react";
import { Button, Skeleton, Badge, Dialog, Input, Label, Select } from "@/components/ui";

type Stage = { id: string; name: string; sortOrder: number; isWon: boolean; isLost: boolean; color: string | null };
type ContactRef = { id: string; displayName: string | null; numberE164: string };
type Deal = {
  id: string;
  name: string;
  stageId: string;
  value: number;
  currency: string;
  owner: { id: string; name: string | null } | null;
  company: { id: string; name: string } | null;
  primaryContact: ContactRef | null;
};

function money(v: number, ccy: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${ccy} ${v.toLocaleString()}`;
  }
}

// Search-as-you-type contact picker shared by the New deal and Edit deal
// dialogs. `apiBase` is "/api/admin/crm" or "/api/agent/crm" — the agent
// contact search lives under that same prefix (/api/agent/crm/contacts),
// but the admin one doesn't (/api/admin/contacts, not /api/admin/crm/contacts)
// since it predates the CRM API namespace, hence the branch below.
function ContactPicker({ apiBase, value, onChange, inputId }: {
  apiBase: string;
  value: ContactRef | null;
  onChange: (contact: ContactRef | null) => void;
  inputId?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContactRef[]>([]);
  const [open, setOpen] = useState(false);
  const contactsUrl = apiBase.includes("/admin/") ? "/api/admin/contacts" : "/api/agent/crm/contacts";

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`${contactsUrl}?q=${encodeURIComponent(q)}&limit=8`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data) => setResults(data.contacts ?? []))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query, contactsUrl]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-[var(--radius)] border bg-surface px-3 py-2 text-sm [border-color:rgb(var(--hairline))]">
        <span className="truncate text-primary">{value.displayName || value.numberE164}</span>
        <button
          type="button"
          aria-label="Remove linked contact"
          className="text-tertiary hover:text-danger"
          onClick={() => onChange(null)}
        >
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
        placeholder="Search contacts by name or number..."
      />
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-[var(--radius)] border bg-surface shadow-xl [border-color:rgb(var(--hairline))]">
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              className="block w-full truncate px-3 py-2 text-left text-sm text-primary hover:bg-canvas"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(c);
                setQuery("");
                setResults([]);
                setOpen(false);
              }}
            >
              {c.displayName || c.numberE164}
              {c.displayName && <span className="ml-1.5 text-[11px] text-tertiary">{c.numberE164}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DealCard({ deal, stages, onMove, onOpen, draggable }: {
  deal: Deal;
  stages: Stage[];
  onMove: (dealId: string, stageId: string) => void;
  onOpen: (deal: Deal) => void;
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id, disabled: !draggable });
  const contactLabel = deal.primaryContact
    ? deal.primaryContact.displayName || deal.primaryContact.numberE164
    : null;
  return (
    <div
      ref={setNodeRef}
      onClick={() => {
        if (!isDragging) onOpen(deal);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(deal);
      }}
      className={`rounded-[var(--radius)] border bg-surface p-3 text-left text-sm [border-color:rgb(var(--hairline))] ${
        isDragging ? "opacity-40" : ""
      } ${draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
      {...(draggable ? { ...listeners, ...attributes } : { role: "button", tabIndex: 0 })}
    >
      <div className="font-medium text-primary">{deal.name}</div>
      <div className="mt-1 font-medium text-accent">{money(deal.value, deal.currency)}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-tertiary">
        {contactLabel && <span className="truncate">{contactLabel}</span>}
        {deal.company && <Badge tone="neutral">{deal.company.name}</Badge>}
      </div>
      {deal.owner?.name && <div className="mt-1 text-[11px] text-tertiary">Owner: {deal.owner.name}</div>}
      {!draggable && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <Select
            aria-label={`Move ${deal.name} to stage`}
            value={deal.stageId}
            onChange={(v) => onMove(deal.id, v)}
            options={stages.map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>
      )}
    </div>
  );
}

function Column({ stage, deals, stages, onMove, onOpen, draggable }: {
  stage: Stage;
  deals: Deal[];
  stages: Stage[];
  onMove: (dealId: string, stageId: string) => void;
  onOpen: (deal: Deal) => void;
  draggable: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = deals.reduce((s, d) => s + d.value, 0);
  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 snap-start flex-col gap-2 rounded-[var(--radius-lg)] border bg-canvas p-2 [border-color:rgb(var(--hairline))] ${
        isOver ? "ring-1 ring-[rgb(var(--accent))]" : ""
      }`}
    >
      <div className="flex items-center justify-between px-1 py-1">
        <span className="text-[13px] font-semibold text-primary">
          {stage.name}
          {stage.isWon && <span className="ml-1 text-success">✓</span>}
          {stage.isLost && <span className="ml-1 text-danger">✕</span>}
        </span>
        <span className="text-[11px] text-tertiary">{deals.length}</span>
      </div>
      <div className="px-1 text-[11px] text-tertiary">{total > 0 ? money(total, deals[0]?.currency ?? "AED") : "—"}</div>
      <div className="flex flex-col gap-2">
        {deals.map((d) => (
          <DealCard key={d.id} deal={d} stages={stages} onMove={onMove} onOpen={onOpen} draggable={draggable} />
        ))}
        {deals.length === 0 && <p className="px-1 py-4 text-center text-[11px] text-tertiary">No deals</p>}
      </div>
    </div>
  );
}

// Kanban shared by /admin/crm/pipeline and /agent/crm/pipeline. `apiBase` is
// "/api/admin/crm" or "/api/agent/crm". Desktop: @dnd-kit drag-drop across
// columns. Mobile (<768px): a horizontal snap-scroll strip and a stage
// <Select> on each card instead of drag.
export function PipelineBoard({ apiBase }: { apiBase: string }) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newContact, setNewContact] = useState<ContactRef | null>(null);
  const [creating, setCreating] = useState(false);

  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [editContact, setEditContact] = useState<ContactRef | null>(null);
  const [saving, setSaving] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const load = useCallback(() => {
    const t = setTimeout(() => setSlow(true), 400);
    fetch(`${apiBase}/pipeline`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        setStages(data.stages ?? []);
        setDeals(data.deals ?? []);
        setError(null);
      })
      .catch(() => setError("Could not load the pipeline."))
      .finally(() => {
        clearTimeout(t);
        setSlow(false);
        setLoading(false);
      });
  }, [apiBase]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const move = useCallback(
    (dealId: string, stageId: string) => {
      const prev = deals.find((d) => d.id === dealId);
      if (!prev || prev.stageId === stageId) return;
      setDeals((ds) => ds.map((d) => (d.id === dealId ? { ...d, stageId } : d)));
      fetch(`${apiBase}/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
        })
        .catch(() => {
          setDeals((ds) => ds.map((d) => (d.id === dealId ? { ...d, stageId: prev.stageId } : d)));
          setError("Could not move that deal.");
        });
    },
    [apiBase, deals],
  );

  const createDeal = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`${apiBase}/pipeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          value: Number(newValue) || 0,
          contactId: newContact?.id ?? undefined,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setNewName("");
      setNewValue("");
      setNewContact(null);
      setShowCreate(false);
      load();
    } catch {
      setError("Could not create the deal.");
    } finally {
      setCreating(false);
    }
  };

  const openDeal = (deal: Deal) => {
    setEditingDeal(deal);
    setEditName(deal.name);
    setEditValue(String(deal.value));
    setEditContact(deal.primaryContact);
  };

  const saveDeal = async () => {
    if (!editingDeal || !editName.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/deals/${editingDeal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          value: Number(editValue) || 0,
          contactId: editContact?.id ?? null,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setEditingDeal(null);
      load();
    } catch {
      setError("Could not save that deal.");
    } finally {
      setSaving(false);
    }
  };

  const byStage = useMemo(() => {
    const map: Record<string, Deal[]> = {};
    for (const s of stages) map[s.id] = [];
    for (const d of deals) (map[d.stageId] ??= []).push(d);
    return map;
  }, [stages, deals]);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (e.over) move(String(e.active.id), String(e.over.id));
  };

  const activeDeal = deals.find((d) => d.id === activeId) ?? null;

  if (loading && slow) {
    return (
      <div className="flex gap-3 overflow-x-auto">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-64 w-72 shrink-0" />
        ))}
      </div>
    );
  }

  const columns = (
    <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none">
      {stages.map((s) => (
        <Column
          key={s.id}
          stage={s}
          deals={byStage[s.id] ?? []}
          stages={stages}
          onMove={move}
          onOpen={openDeal}
          draggable={!isMobile}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-tertiary">
          {deals.length} deal{deals.length === 1 ? "" : "s"}
          {isMobile ? " · use the stage menu on each card" : " · drag a card to move it"}
        </p>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus size={15} /> New deal
        </Button>
      </div>
      {error && <p className="text-[13px] text-danger">{error}</p>}

      {isMobile ? (
        columns
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          {columns}
          <DragOverlay>
            {activeDeal ? (
              <div className="w-64 rounded-[var(--radius)] border bg-surface p-3 text-sm shadow-xl [border-color:rgb(var(--hairline))]">
                <div className="font-medium text-primary">{activeDeal.name}</div>
                <div className="text-accent">{money(activeDeal.value, activeDeal.currency)}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="New deal">
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="deal-name">Name</Label>
            <Input id="deal-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Acme renewal" />
          </div>
          <div>
            <Label htmlFor="deal-value">Value</Label>
            <Input
              id="deal-value"
              type="number"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="0"
            />
          </div>
          <div>
            <Label htmlFor="deal-contact">Contact</Label>
            <ContactPicker apiBase={apiBase} value={newContact} onChange={setNewContact} inputId="deal-contact" />
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
            <Button onClick={createDeal} disabled={creating || !newName.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={editingDeal !== null} onClose={() => setEditingDeal(null)} title="Edit deal">
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="edit-deal-name">Name</Label>
            <Input id="edit-deal-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit-deal-value">Value</Label>
            <Input id="edit-deal-value" type="number" value={editValue} onChange={(e) => setEditValue(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit-deal-contact">Contact</Label>
            <ContactPicker apiBase={apiBase} value={editContact} onChange={setEditContact} inputId="edit-deal-contact" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditingDeal(null)}>
              Cancel
            </Button>
            <Button onClick={saveDeal} disabled={saving || !editName.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
