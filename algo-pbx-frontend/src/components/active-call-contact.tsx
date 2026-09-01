"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useSIP } from "@/contexts/sip-context";
import { formatUnknownCaller } from "@/lib/caller-id-format";

interface MatchedContact {
  id: string;
  numberE164: string;
  displayName: string | null;
  owner: { id: string; name: string; extension: { number: string; status: string } | null } | null;
}

// CRM context for the current call (LLM.md §31) — mounted in
// call-controls.tsx for both the ringing and active/held states.
// `identity` is sip-context.tsx's `incomingCallerId`, which may be a
// display name, a bare number, or (when the far end sets no display name)
// a full SIP URI string — best-effort: GET /api/agent/crm/contacts's own
// `contains` search still usually finds the right row even given the
// extra "sip:...@host" noise, since the digits remain a substring. Not
// wired for outbound calls — the dialed number lives inside Dialpad's own
// local state today, never shared up to this component; a real, separate
// gap, not attempted here.
//
// Feature B4 (2026-08-31) — when the resolved contact IS owned by someone
// else, show "Customer of <owner>" instead of a normal deep link (viewing
// the contact would hit the read-only/owner-badge wall in contact-detail.tsx
// anyway — telling the agent up front is more useful than a click that
// leads to a locked form), plus a one-click warm transfer to the owner's
// extension when Extension.status shows them as not OFFLINE. Real PJSIP
// registration/qualify-based "online" detection was scoped out of an
// earlier session (EscalationTarget) as too complex; this reuses the
// existing self-reported Extension.status signal rather than reopening
// that wall — an honest, coarser proxy for "online," not the real thing.
export function ActiveCallContact({ identity }: { identity: string | null }) {
  const { data: session } = useSession();
  const { blindTransfer, callState } = useSIP();
  const [match, setMatch] = useState<MatchedContact | null | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  useEffect(() => {
    if (!identity) {
      setMatch(undefined);
      return;
    }
    let cancelled = false;
    setMatch(undefined);
    // scope=all — resolving who's calling must see every contact, not just
    // the viewer's own (GET /api/agent/crm/contacts defaults to "mine" for
    // the list UI; this lookup is a different use case — see that route's
    // comment).
    fetch(`/api/agent/crm/contacts?q=${encodeURIComponent(identity)}&limit=1&scope=all`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { contacts: [] }))
      .then((data) => {
        if (!cancelled) setMatch(data.contacts?.[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setMatch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [identity]);

  if (!identity || match === undefined) return null;

  if (match) {
    const viewerId = session?.user?.id;
    const isOwnedByOther = Boolean(match.owner && match.owner.id !== viewerId);
    const ownerExtension = match.owner?.extension;
    const ownerOnline = ownerExtension && ownerExtension.status !== "OFFLINE";
    const canWarmTransfer = isOwnedByOther && ownerOnline && (callState === "active" || callState === "held");

    const warmTransfer = async () => {
      if (!ownerExtension || transferring) return;
      setTransferring(true);
      setTransferError(null);
      try {
        await blindTransfer(ownerExtension.number);
      } catch (err) {
        setTransferError(err instanceof Error ? err.message : "Transfer failed.");
      } finally {
        setTransferring(false);
      }
    };

    return (
      <div className="text-center text-xs text-slate-400">
        {isOwnedByOther ? (
          <p>
            Customer of <span className="text-slate-200">{match.owner!.name}</span> —{" "}
            <Link href={`/agent?contact=${match.id}`} className="text-cyan hover:underline">
              view
            </Link>
          </p>
        ) : (
          <p>
            Contact:{" "}
            <Link href={`/agent?contact=${match.id}`} className="text-cyan hover:underline">
              {match.displayName ?? match.numberE164}
            </Link>
          </p>
        )}
        {isOwnedByOther && (
          <p className="mt-1">
            {ownerExtension ? (
              canWarmTransfer ? (
                <button onClick={warmTransfer} disabled={transferring} className="text-cyan hover:underline disabled:opacity-50">
                  {transferring ? "Transferring…" : `Warm transfer to ${match.owner!.name}`}
                </button>
              ) : (
                <span className="text-slate-500">{ownerOnline ? "Warm transfer available once on an active call." : `${match.owner!.name} is offline.`}</span>
              )
            ) : (
              <span className="text-slate-500">{match.owner!.name} has no extension to transfer to.</span>
            )}
          </p>
        )}
        {transferError && <p className="mt-1 text-red-400">{transferError}</p>}
      </div>
    );
  }

  const createContact = async () => {
    if (creating || !identity) return;
    setCreating(true);
    try {
      // `identity` may be a full SIP URI ("sip:971502644615@host") when the
      // far end sets no display name — the create route validates a real
      // parseable phone number, unlike the search above's tolerant
      // `contains` match, so the digits need extracting first.
      const digitsOnly = identity.match(/\+?\d[\d\s-]{5,}\d/)?.[0]?.replace(/[\s-]/g, "") ?? identity;
      const res = await fetch("/api/agent/crm/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numberE164: digitsOnly }),
      });
      const data = await res.json().catch(() => null);
      // A 409 "already exists" response still carries the existing
      // contact, so this isn't gated on res.ok.
      if (data?.contact) setMatch(data.contact);
    } finally {
      setCreating(false);
    }
  };

  // Feature C1 (2026-08-31) — never a bare number for an unknown caller;
  // formatUnknownCaller adds country/type metadata from libphonenumber-js
  // where it can determine them, and degrades to the raw identity when it
  // can't parse it as a phone number at all (e.g. a bare SIP URI).
  return (
    <p className="text-center text-xs text-slate-500">
      {formatUnknownCaller(identity)} —{" "}
      <button onClick={createContact} disabled={creating} className="text-cyan hover:underline disabled:opacity-50">
        {creating ? "Adding…" : "Add to CRM"}
      </button>
    </p>
  );
}
