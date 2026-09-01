"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSIP } from "@/contexts/sip-context";
import { useMissedCallsRefresh } from "@/components/agent-shell/agent-shell";

interface MissedCall {
  id: string;
  callerNumber: string;
  /** Resolved by GET /api/me/missed-calls via src/lib/contact-display.ts —
   * same fallback rule as the admin CDR page's callerDisplayName. Null
   * when the number matches no Contact row. */
  callerDisplayName: string | null;
  /** CRM deep-link target (LLM.md §31) — null when no Contact matches. */
  callerContactId: string | null;
  startedAt: string;
  disposition: string;
}

// Derived entirely from CallDetailRecord via GET /api/me/missed-calls — no
// new call-log table exists or is needed. Same polling pattern as
// AgentVoicemail/AgentRecordings (this codebase has no websocket/SSE
// transport). Marks the list "seen" (clearing the unread badge in
// AgentShell) as soon as it's rendered with at least one call, matching
// how /admin/sign-ins treats "viewed the page" as "seen".
export function AgentMissedCalls() {
  const { makeCall } = useSIP();
  const refreshBadge = useMissedCallsRefresh();
  const [calls, setCalls] = useState<MissedCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/me/missed-calls", { cache: "no-store" });
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setCalls(data.calls ?? []);
    } catch {
      setError("Could not load missed calls.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (calls.length > 0) {
      fetch("/api/me/missed-calls", { method: "POST" })
        .then(() => refreshBadge())
        .catch(() => undefined);
    }
    // refreshBadge is a stable ref-backed callback from AgentShell's
    // context (see useBadgeCount there) — not expected to change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls.length]);

  // Rendering nothing at all for BOTH "still loading" and "genuinely zero
  // missed calls" made the two indistinguishable on screen — confirmed
  // live 2026-08-29 alongside the agentExtension/direction CDR bugs, which
  // meant this list was ALWAYS empty and looked identical to "the
  // component is broken" the entire time. Loading still renders nothing
  // (a flash of "No missed calls" on every page load would be worse), but
  // a confirmed-empty result now says so explicitly.
  if (loading && calls.length === 0 && !error) return null;
  if (error && calls.length === 0) {
    return (
      <div className="glass-card w-full max-w-2xl p-6">
        <p className="text-xs text-danger">{error}</p>
      </div>
    );
  }
  if (calls.length === 0) {
    return (
      <div className="glass-card w-full max-w-2xl p-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-secondary">Missed Calls</h2>
        <p className="text-xs text-tertiary">No missed calls.</p>
      </div>
    );
  }

  return (
    <div className="glass-card w-full max-w-2xl p-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">Missed Calls</h2>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      <ul className="flex flex-col gap-3 text-sm text-primary">
        {calls.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-0 first:pt-0">
            <div>
              <p>{c.callerDisplayName ?? c.callerNumber}</p>
              <p className="text-xs text-tertiary">
                {new Date(c.startedAt).toLocaleString()} · {c.disposition}
                {c.callerContactId && (
                  <>
                    {" · "}
                    <Link href={`/agent?contact=${c.callerContactId}`} className="text-cyan hover:underline">
                      View in CRM
                    </Link>
                  </>
                )}
              </p>
            </div>
            <button
              onClick={() => makeCall(c.callerNumber)}
              className="rounded-lg border border-border px-3 py-1 text-xs text-cyan hover:border-cyan"
            >
              Call back
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
