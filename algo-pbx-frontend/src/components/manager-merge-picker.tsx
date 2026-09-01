"use client";

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import { useSIP } from "@/contexts/sip-context";

interface EscalationTarget {
  id: string;
  name: string;
  extension: string | null;
  phoneE164: string | null;
}

// Phase MM (LLM.md §29/§30) — bring a manager into the live call, sourced
// from the SAME admin-managed list EscalationPicker already reads
// (GET /api/agent/escalation-targets). Deliberately a separate component
// rather than extending EscalationPicker: that one performs a
// blindTransfer() (hands the call AWAY); this one performs a merge (the
// agent stays on the call) — different action, different backend route
// (POST /api/calls/manager-merge), different failure modes worth their
// own copy. Only rendered during an active call — see call-controls.tsx.
//
// A manager WITHOUT an extension is shown but not selectable (existing
// WhatsApp-ping affordance already covers that case via EscalationPicker
// above this component — no separate ping button duplicated here).
// Deactivated managers never appear at all (the API's own `active: true`
// filter). "Offline" (registered vs. not) detection was scoped out of
// this pass — see the API route's own header for why — so a manager with
// an extension is always shown selectable; a genuinely unreachable
// extension surfaces as a real failure message after the attempt, not a
// pre-emptive grey-out.
export function ManagerMergePicker() {
  const { callState } = useSIP();
  const [targets, setTargets] = useState<EscalationTarget[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: "ok" | "warn" | "error" } | null>(null);

  useEffect(() => {
    fetch("/api/agent/escalation-targets", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { targets: [] }))
      .then((data) => setTargets(data.targets ?? []))
      .catch(() => setTargets([]));
  }, []);

  const mergeable = targets.filter((t) => t.extension);

  const merge = useCallback(async () => {
    const target = targets.find((t) => t.id === selected);
    if (!target || !target.extension || busy || (callState !== "active" && callState !== "held")) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/calls/manager-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: target.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`);
      setResult({ text: data.message, tone: data.answered ? "ok" : "warn" });
    } catch (err) {
      setResult({ text: err instanceof Error ? err.message : "Merge failed.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [busy, callState, selected, targets]);

  if (mergeable.length === 0 && targets.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">Merge manager into call</p>
      <div className="flex gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-cyan"
        >
          <option value="">Select a manager…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id} disabled={!t.extension}>
              {t.name}
              {!t.extension ? " (no extension — not mergeable)" : ""}
            </option>
          ))}
        </select>
        <button
          onClick={merge}
          disabled={!selected || busy}
          title="Bring this manager into the current call"
          className="flex items-center gap-1 rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-background disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Users className="h-3.5 w-3.5" />
          {busy ? "Merging…" : "Merge"}
        </button>
      </div>
      {result && (
        <p
          className={`text-xs ${
            result.tone === "ok" ? "text-green-400" : result.tone === "warn" ? "text-amber-400" : "text-red-400"
          }`}
        >
          {result.text}
        </p>
      )}
    </div>
  );
}
