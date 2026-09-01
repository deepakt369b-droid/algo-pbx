"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSIP } from "@/contexts/sip-context";
import { useCrmCallContext } from "@/components/crm/crm-call-context";
import { Dialog } from "@/components/ui";
import { cn } from "@/lib/utils";

// DispositionPrompt (node W, W3) — auto-disposition after a call.
//
// Fires when callState transitions to "idle" HAVING been in a call
// (calling/ringing/active/held) AND CrmCallContext holds a contactId for
// that call. Resolves the CDR row via GET
// /api/agent/crm/call-context/latest-call — NOT from SIP state, which
// exposes no call id (plan G3). POSTs to the EXISTING
// /api/agent/crm/dispositions (which also writes DoNotCallEntry on DNC, in
// its own transaction). Skippable.
//
// Mount point: src/app/agent/layout.tsx.

const OUTCOMES = [
  { key: "INTERESTED", label: "Interested" },
  { key: "CALLBACK", label: "Callback" },
  { key: "NOT_INTERESTED", label: "Not interested" },
  { key: "DNC", label: "DNC" },
] as const;

type Outcome = (typeof OUTCOMES)[number]["key"];

const IN_CALL = new Set(["calling", "ringing", "active", "held"]);

export function DispositionPrompt() {
  const { callState } = useSIP();
  const { lastIdentity, setCallIdentity } = useCrmCallContext();
  const wasInCall = useRef(false);

  const [open, setOpen] = useState(false);
  const [contact, setContact] = useState<{ id: string; name: string | null } | null>(null);
  const [cdrUniqueId, setCdrUniqueId] = useState<string | undefined>(undefined);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedOutcome, setSavedOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (IN_CALL.has(callState)) {
      wasInCall.current = true;
      return;
    }
    // callState === "idle"
    if (!wasInCall.current) return;
    wasInCall.current = false;

    const id = lastIdentity?.contactId;
    if (!id) {
      setCallIdentity(null);
      return;
    }

    setContact({ id, name: lastIdentity?.contactName ?? null });
    setNote("");
    setError(null);
    setSavedOutcome(null);
    setOpen(true);

    // Resolve the just-ended call's CDR uniqueId (best effort — a call
    // placed before the agentExtension CDR fix, or ingested late, simply
    // yields no id and the disposition is recorded without cdrUniqueId,
    // which the schema allows).
    fetch("/api/agent/crm/call-context/latest-call", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setCdrUniqueId(data?.call?.uniqueId ?? undefined))
      .catch(() => setCdrUniqueId(undefined));
  }, [callState, lastIdentity, setCallIdentity]);

  const close = () => {
    setOpen(false);
    setCallIdentity(null);
  };

  const record = async (outcome: Outcome) => {
    if (!contact || saving) return;
    setSaving(outcome);
    setError(null);
    try {
      const res = await fetch("/api/agent/crm/dispositions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          cdrUniqueId,
          outcome,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? "Failed to record disposition");
      }
      setSavedOutcome(outcome);
      // INTERESTED keeps the dialog open to offer "Create deal"; the others
      // are done — close straight away.
      if (outcome !== "INTERESTED") close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record disposition.");
    } finally {
      setSaving(null);
    }
  };

  if (!contact) return null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="How did that call go?"
      description={contact.name ? `Disposition for ${contact.name}` : "Disposition for this contact"}
      size="sm"
    >
      <div className="flex flex-col gap-3">
        {savedOutcome === "INTERESTED" ? (
          <>
            <p className="text-sm text-primary">Marked interested.</p>
            <Link
              href={`/agent/crm/pipeline?newDealContact=${contact.id}`}
              onClick={close}
              className="inline-flex h-10 items-center justify-center rounded-[var(--radius)] bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              Create deal
            </Link>
            <button type="button" onClick={close} className="text-[13px] text-tertiary hover:text-primary">
              Not now
            </button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              {OUTCOMES.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  disabled={saving !== null}
                  onClick={() => record(o.key)}
                  className={cn(
                    "h-10 rounded-[var(--radius)] border text-sm text-primary hover:bg-surface-hover disabled:opacity-40 [border-color:rgb(var(--hairline))]",
                    o.key === "DNC" && "text-danger",
                  )}
                >
                  {saving === o.key ? "Saving…" : o.label}
                </button>
              ))}
            </div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note"
              className="h-10 rounded-[var(--radius)] border bg-canvas px-3 text-sm text-primary outline-none focus:border-accent [border-color:rgb(var(--hairline))]"
            />
            {error && <p className="text-[12px] text-danger">{error}</p>}
            <button type="button" onClick={close} className="self-start text-[13px] text-tertiary hover:text-primary">
              Skip
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
