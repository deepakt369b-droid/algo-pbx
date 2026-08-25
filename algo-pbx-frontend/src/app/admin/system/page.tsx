"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";

interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "unknown";
  detail: string;
  hint?: string;
  docsHref?: string;
  checkedAt: string;
}

const REFRESH_INTERVAL_MS = 15000;

const STATUS_STYLE: Record<HealthCheck["status"], { dot: string; text: string; label: string }> = {
  ok: { dot: "bg-green-400", text: "text-green-400", label: "OK" },
  warn: { dot: "bg-yellow-400", text: "text-yellow-400", label: "Warning" },
  fail: { dot: "bg-red-400", text: "text-red-400", label: "Failing" },
  unknown: { dot: "bg-slate-500", text: "text-slate-500", label: "Unknown" },
};

// System readiness — the aggregated, authenticated view behind
// GET /api/admin/system/health. Every dependency the product needs, with
// a plain-language hint and a link to the page that fixes it, so a
// failing check reads as a checklist item rather than a mystery "app not
// ready" feeling.
export default function SystemPage() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [overall, setOverall] = useState<HealthCheck["status"]>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const data = await apiFetch<{ checks: HealthCheck[]; overall: HealthCheck["status"] }>("/api/admin/system/health");
      setChecks(data.checks);
      setOverall(data.overall);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load system status.");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const overallStyle = STATUS_STYLE[overall];

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">System Readiness</h1>
      <p className="max-w-2xl text-center text-xs text-slate-500">
        Every dependency this product needs, checked live. A warning or failure links to where to fix it.
      </p>

      <div className={`glass-card flex w-full max-w-2xl items-center justify-between p-4 ${overallStyle.text}`}>
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className={`h-2.5 w-2.5 rounded-full ${overallStyle.dot}`} />
          Overall: {overallStyle.label}
        </span>
        <button onClick={load} disabled={refreshing} className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50">
          {refreshing ? "Checking…" : "Re-check all"}
        </button>
      </div>

      {error && (
        <div className="w-full max-w-2xl rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="flex w-full max-w-2xl flex-col gap-3">
        {checks.map((c) => {
          const style = STATUS_STYLE[c.status];
          return (
            <div key={c.id} className="glass-card flex flex-col gap-1 p-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                  {c.label}
                </span>
                <span className={`text-xs ${style.text}`}>{style.label}</span>
              </div>
              <p className="text-xs text-slate-500">{c.detail}</p>
              {c.hint && (c.status === "warn" || c.status === "fail") && (
                <p className="text-xs text-slate-400">
                  {c.hint}
                  {c.docsHref && (
                    <>
                      {" "}
                      <a href={c.docsHref} className="text-cyan hover:underline">
                        Fix this
                      </a>
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
