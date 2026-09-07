"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import type { GatewaySite } from "./site-table";

interface CutoverResult {
  ok: boolean;
  error?: string;
  provision?: { verified?: boolean };
}

// "Cut over now" — the manual re-point button for the existing, already
// AMI-read-back-verified POST /api/admin/gateway-sites/[id]/cutover route
// (src/lib/dinstar/site-cutover.ts). Does NOT reimplement any cutover
// logic — this component only calls that route and renders its result.
// Confirm step is load-bearing: this re-points the LIVE SIP trunk.
export function CutoverButton({ site }: { site: GatewaySite }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CutoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cutover = async () => {
    if (
      !confirm(
        `Cut the live SIP trunk over to "${site.name}" (${site.tunnelIp ?? site.gatewayLanIp}) now?\n\nThis re-points production call routing immediately.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiFetch<CutoverResult>(`/api/admin/gateway-sites/${site.id}/cutover`, { method: "POST" });
      setResult(data);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setResult((err.details as CutoverResult) ?? null);
      } else {
        setError("Could not reach the cutover route.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button onClick={cutover} disabled={busy} className="text-xs text-warning hover:underline disabled:opacity-50">
        {busy ? "Cutting over…" : "Cut over now"}
      </button>
      {error && <p className="text-[11px] text-danger">{error}</p>}
      {result?.provision?.verified === false && (
        <p className="text-[11px] text-warning">
          Setting changed, but the trunk re-point was not confirmed live — check the site manually.
        </p>
      )}
      {result?.provision?.verified === true && <p className="text-[11px] text-success">Cutover verified live.</p>}
    </div>
  );
}
