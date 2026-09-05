"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type OverallStatus = "ok" | "warn" | "fail" | "unknown";

// A deliberate sibling of admin-shell/health-pill.tsx rather than a shared
// generalisation of it. The two poll different endpoints with different
// semantics — the admin pill reports one tenant's dependencies, this one
// reports the platform's shared infrastructure (Asterisk, Postgres, OpenVPN,
// Headscale, syslog, Caddy) across every tenant. Merging them would mean a
// component that takes an endpoint and a link target and owns neither
// meaning, and the admin pill has its own known quirks recorded in handoff.md
// that should not propagate here.

const DOT: Record<OverallStatus, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  fail: "bg-danger",
  unknown: "bg-surface-hover",
};
const LABEL: Record<OverallStatus, string> = {
  ok: "Platform healthy",
  warn: "Needs attention",
  fail: "Platform failing",
  unknown: "Checking…",
};

const POLL_MS = 30000;

export function PlatformHealthPill() {
  const [status, setStatus] = useState<OverallStatus>("unknown");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/platform/health");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { overall: OverallStatus };
        if (!cancelled) setStatus(data.overall);
      } catch {
        // "unknown", never "ok": a pill that cannot reach its own endpoint
        // must not render green. Failing closed on a status indicator is the
        // difference between "we do not know" and a false all-clear.
        if (!cancelled) setStatus("unknown");
      }
    };
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <Link
      href="/platform"
      title={LABEL[status]}
      data-testid="platform-health-pill"
      data-status={status}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover [border-color:rgb(var(--hairline))]"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
      <span className="hidden sm:inline">{LABEL[status]}</span>
    </Link>
  );
}
