"use client";

import { useCallback, useEffect, useState } from "react";
import { PhoneCall } from "lucide-react";
import { useSIP } from "@/contexts/sip-context";

interface EscalationTarget {
  id: string;
  name: string;
  extension: string | null;
  phoneE164: string | null;
}

// Manager escalation (Loop C1) — a dropdown over the admin-managed named
// list, feeding the EXISTING blindTransfer() with a configured target
// rather than inventing a new transfer mechanism. Only rendered during an
// active call (see call-controls.tsx) since escalating requires a live
// call to transfer.
export function EscalationPicker() {
  const { blindTransfer, callState } = useSIP();
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

  const escalate = useCallback(async () => {
    const target = targets.find((t) => t.id === selected);
    if (!target || busy || (callState !== "active" && callState !== "held")) return;
    setBusy(true);
    setResult(null);
    try {
      // Fired concurrently: the transfer itself doesn't depend on the
      // server-side outcome watch succeeding, and vice versa — an AMI
      // hiccup on the observation side must never block the actual call
      // transfer the agent asked for.
      const transferTarget = target.extension ?? target.phoneE164;
      if (!transferTarget) throw new Error("This target has no reachable number.");
      const [, apiResult] = await Promise.all([
        blindTransfer(transferTarget),
        fetch("/api/agent/escalate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId: target.id }),
        }).then((r) => r.json()),
      ]);
      if (apiResult.outcome === "BUSY" || apiResult.outcome === "NO_ANSWER" || apiResult.outcome === "FAILED") {
        setResult({
          text: `${target.name} didn't pick up (${apiResult.outcome.toLowerCase().replace("_", " ")})${apiResult.waNotified ? " — notified via WhatsApp." : "."}`,
          tone: "warn",
        });
      } else if (apiResult.outcome === "ANSWERED") {
        setResult({ text: `Transferred to ${target.name}.`, tone: "ok" });
      }
    } catch (err) {
      // blindTransfer() runs transfer-guard.ts's evaluateTransferPermission
      // internally and throws its reason verbatim. Confirmed live
      // 2026-08-29: escalating an inbound GSM call (origin "trunk") to a
      // manager with only a phoneE164 (no internal extension) hits this
      // guard every time — a REFER to an external number would dial a
      // second leg through the same, already-occupied GSM port. That is
      // real hardware-limit protection working as designed, but the raw
      // transfer-guard wording ("this line only has one connection") gives
      // no indication this was an ESCALATION attempt or what to do about
      // it. Recognize that specific message here and give the admin a
      // concrete, actionable next step instead.
      const message = err instanceof Error ? err.message : "Escalation failed.";
      const isSinglePortGuard = message.includes("only has one connection");
      setResult({
        text: isSinglePortGuard
          ? `Can't reach ${target.name} — they have no internal extension, and this GSM line can't place a second outside call while a customer is on it. Add an internal extension for ${target.name}, or a second registered SIM, to enable this.`
          : message,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [blindTransfer, busy, callState, selected, targets]);

  if (targets.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs uppercase tracking-wide text-tertiary">Escalate to manager</p>
      <div className="flex gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-cyan"
        >
          <option value="">Select a manager…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          onClick={escalate}
          disabled={!selected || busy}
          aria-label="Escalate to manager"
          className="flex items-center gap-1 rounded-lg bg-blue px-3 py-1.5 text-xs font-medium text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PhoneCall className="h-3.5 w-3.5" />
          {busy ? "…" : "Go"}
        </button>
      </div>
      {result && (
        <p className={`text-xs ${result.tone === "ok" ? "text-success" : result.tone === "warn" ? "text-warning" : "text-danger"}`}>
          {result.text}
        </p>
      )}
    </div>
  );
}
