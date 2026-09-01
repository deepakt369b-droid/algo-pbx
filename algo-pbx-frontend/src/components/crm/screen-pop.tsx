"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { useSIP } from "@/contexts/sip-context";
import { useCrmCallContext } from "@/components/crm/crm-call-context";
import { formatUnknownCaller } from "@/lib/caller-id-format";
import { cn } from "@/lib/utils";

// ScreenPop (node W, W1) — inbound screen-pop. Watches
// useSIP().incomingCallerId (READ-ONLY) while callState === "ringing",
// resolves it against the CRM, and shows a dismissable card. It never
// steals keyboard focus (no autoFocus, no focus() call, not a modal) —
// an agent mid-sentence in a note must not be interrupted (Doherty).
//
// Mount point: src/app/agent/layout.tsx.

interface MatchedContact {
  id: string;
  numberE164: string;
  displayName: string | null;
}

export function ScreenPop() {
  const { callState, incomingCallerId } = useSIP();
  const { mergeCallIdentity } = useCrmCallContext();
  const [match, setMatch] = useState<MatchedContact | null | undefined>(undefined);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const lastLookup = useRef<string | null>(null);

  const ringing = callState === "ringing" && Boolean(incomingCallerId);

  useEffect(() => {
    if (!ringing || !incomingCallerId) {
      setMatch(undefined);
      lastLookup.current = null;
      return;
    }
    if (lastLookup.current === incomingCallerId) return;
    lastLookup.current = incomingCallerId;

    let cancelled = false;
    setMatch(undefined);
    // scope=all — resolving who's calling must see every contact, not just
    // the viewer's own (see GET /api/agent/crm/contacts's own comment).
    fetch(`/api/agent/crm/contacts?q=${encodeURIComponent(incomingCallerId)}&limit=1&scope=all`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { contacts: [] }))
      .then((data) => {
        if (cancelled) return;
        const c: MatchedContact | null = data.contacts?.[0] ?? null;
        setMatch(c);
        mergeCallIdentity({
          number: c?.numberE164 ?? incomingCallerId,
          contactId: c?.id ?? null,
          contactName: c?.displayName ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setMatch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ringing, incomingCallerId, mergeCallIdentity]);

  if (!ringing || !incomingCallerId) return null;
  if (dismissedFor === incomingCallerId) return null;
  if (match === undefined) return null;

  const createContact = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const digitsOnly =
        incomingCallerId.match(/\+?\d[\d\s-]{5,}\d/)?.[0]?.replace(/[\s-]/g, "") ?? incomingCallerId;
      const res = await fetch("/api/agent/crm/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numberE164: digitsOnly }),
      });
      const data = await res.json().catch(() => null);
      if (data?.contact) {
        setMatch(data.contact);
        mergeCallIdentity({
          number: data.contact.numberE164,
          contactId: data.contact.id,
          contactName: data.contact.displayName ?? null,
        });
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className={cn(
        "fixed right-4 top-4 z-40 w-[20rem] max-w-[calc(100vw-2rem)]",
        "rounded-[var(--radius-lg)] border bg-surface p-3 shadow-xl [border-color:rgb(var(--hairline))]",
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">Incoming call</span>
        <button
          type="button"
          onClick={() => setDismissedFor(incomingCallerId)}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius)] text-tertiary hover:bg-surface-hover hover:text-primary"
        >
          <X size={14} />
        </button>
      </div>

      {match ? (
        <div className="mt-1">
          <p className="truncate text-sm font-medium text-primary">{match.displayName ?? match.numberE164}</p>
          <p className="truncate text-[12px] text-secondary">{match.numberE164}</p>
          <Link href={`/agent?contact=${match.id}`} className="mt-1 inline-block text-[12px] text-accent hover:underline">
            Open in CRM
          </Link>
        </div>
      ) : (
        <div className="mt-1">
          <p className="text-sm text-primary">{formatUnknownCaller(incomingCallerId)}</p>
          <button
            type="button"
            onClick={createContact}
            disabled={creating}
            className="mt-1 text-[12px] text-accent hover:underline disabled:opacity-50"
          >
            {creating ? "Adding…" : "Add to CRM"}
          </button>
        </div>
      )}
    </div>
  );
}
