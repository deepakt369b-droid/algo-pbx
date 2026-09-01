"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type OverallStatus = "ok" | "warn" | "fail" | "unknown";

const DOT: Record<OverallStatus, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  fail: "bg-danger",
  unknown: "bg-surface-hover",
};
const LABEL: Record<OverallStatus, string> = {
  ok: "All systems OK",
  warn: "Needs attention",
  fail: "Failing",
  unknown: "Checking…",
};

const POLL_MS = 30000;

// Topbar health pill wired to GET /api/admin/system/health — links straight
// to /admin/system so a red/yellow pill is one click from the fix.
export function HealthPill() {
  const [status, setStatus] = useState<OverallStatus>("unknown");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/system/health");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { overall: OverallStatus };
        if (!cancelled) setStatus(data.overall);
      } catch {
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
      href="/admin/system"
      title={LABEL[status]}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover [border-color:rgb(var(--hairline))]"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
      <span className="hidden sm:inline">{LABEL[status]}</span>
    </Link>
  );
}
