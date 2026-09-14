"use client";

import { useEffect, useState } from "react";
import type { CdrRow } from "@/types";
import { Dialog } from "@/components/ui";

// One AI-handled call, keyed by CallDetailRecord.uniqueId — see
// GET /api/admin/ai/call-sessions (new for W7's CDR/reports merge; that
// route's own header explains why it's a separate lookup rather than a
// join baked into GET /api/cdr).
interface AiSessionInfo {
  cdrUniqueId: string;
  transcript: Array<{ role: "agent" | "caller"; text: string; at: string }> | null;
  summary: string | null;
  outcome: string | null;
  handoffExtensionId: string | null;
  aiAgent: { name: string } | null;
}

// The API has always supported ?agent=&from=&to=&limit= filtering (Zod-
// validated in api/cdr/route.ts) — this UI finally exposes it. Date inputs
// feed the schema's date-or-datetime branch directly; the agent field
// matches its 3-6 digit extension regex.
export function CdrTable() {
  const [rows, setRows] = useState<CdrRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [aiSessions, setAiSessions] = useState<Record<string, AiSessionInfo>>({});
  const [aiOnly, setAiOnly] = useState(false);
  const [transcriptFor, setTranscriptFor] = useState<string | null>(null);

  const loadAiSessions = async (uniqueIds: string[]) => {
    if (uniqueIds.length === 0) {
      setAiSessions({});
      return;
    }
    try {
      const res = await fetch(`/api/admin/ai/call-sessions?uniqueIds=${encodeURIComponent(uniqueIds.join(","))}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok) setAiSessions(data.sessions ?? {});
    } catch {
      // Best-effort — a failure here just means no AI badges/filter this
      // load, not a broken CDR table.
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (/^\d{3,6}$/.test(agent)) params.set("agent", agent);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("limit", "50");
    try {
      const res = await fetch(`/api/cdr?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load records");
      const loadedRows: CdrRow[] = data.rows ?? [];
      setRows(loadedRows);
      void loadAiSessions(loadedRows.map((r) => r.uniqueId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only; refetch is explicit via Apply
  }, []);

  const applyFilters = () => {
    load();
  };

  const resetFilters = () => {
    setAgent("");
    setFrom("");
    setTo("");
    setLoading(true);
    fetch("/api/cdr?limit=50", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const loadedRows: CdrRow[] = data.rows ?? [];
        setRows(loadedRows);
        void loadAiSessions(loadedRows.map((r) => r.uniqueId));
      })
      .finally(() => setLoading(false));
  };

  const visibleRows = aiOnly ? rows.filter((row) => Boolean(aiSessions[row.uniqueId])) : rows;
  const activeTranscriptSession = transcriptFor ? aiSessions[transcriptFor] : null;

  return (
    <div className="glass-card w-full max-w-4xl overflow-x-auto p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-secondary">
        Call Detail Records
      </h2>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-tertiary">
          Agent ext.
          <input
            value={agent}
            onChange={(e) => setAgent(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="1001"
            className="w-24 rounded border border-border bg-background px-2 py-1 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-tertiary">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-tertiary">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>
        <button
          onClick={applyFilters}
          className="rounded bg-cyan px-3 py-1.5 text-xs font-medium text-accent-fg"
        >
          Apply
        </button>
        <button onClick={resetFilters} className="text-xs text-secondary hover:text-primary">
          Reset
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-secondary">
          <input type="checkbox" checked={aiOnly} onChange={(e) => setAiOnly(e.target.checked)} />
          AI-handled only
        </label>
      </div>

      {loading && <p className="text-tertiary">Loading call records…</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {!loading && !error && visibleRows.length === 0 && (
        <p className="text-tertiary">{aiOnly ? "No AI-handled calls in this range." : "No calls recorded yet."}</p>
      )}
      {!loading && !error && visibleRows.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-tertiary">
            <tr>
              <th className="pb-2">Started</th>
              <th className="pb-2">From</th>
              <th className="pb-2">To</th>
              <th className="pb-2">Direction</th>
              <th className="pb-2">Duration</th>
              <th className="pb-2">Disposition</th>
              <th className="pb-2">Handled by</th>
              <th className="pb-2">Recording</th>
            </tr>
          </thead>
          <tbody className="text-primary">
            {visibleRows.map((row) => {
              const aiSession = aiSessions[row.uniqueId];
              return (
                <tr
                  key={row.id}
                  className={`border-t border-border ${aiSession ? "cursor-pointer hover:bg-cyan/5" : ""}`}
                  onClick={aiSession ? () => setTranscriptFor(row.uniqueId) : undefined}
                >
                  <td className="py-2">{new Date(row.startedAt).toLocaleString()}</td>
                  <td className="py-2">{row.callerDisplayName ?? row.callerNumber}</td>
                  <td className="py-2">{row.destination}</td>
                  <td className="py-2">{row.direction}</td>
                  <td className="py-2">{row.durationSec}s</td>
                  <td className="py-2">{row.disposition}</td>
                  <td className="py-2">
                    {aiSession ? (
                      <span className="rounded-full border border-cyan/40 bg-cyan/10 px-2 py-0.5 text-xs text-cyan">
                        AI{aiSession.aiAgent ? ` · ${aiSession.aiAgent.name}` : ""}
                      </span>
                    ) : (
                      <span className="text-tertiary">Human</span>
                    )}
                  </td>
                  <td className="py-2">
                    {row.recordingUrl ? (
                      <audio controls src={row.recordingUrl} className="h-8" onClick={(e) => e.stopPropagation()} />
                    ) : (
                      <span className="text-tertiary">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <Dialog
        open={Boolean(transcriptFor && activeTranscriptSession)}
        onClose={() => setTranscriptFor(null)}
        title="AI call transcript"
        description={activeTranscriptSession?.aiAgent ? `Handled by ${activeTranscriptSession.aiAgent.name}` : undefined}
        size="lg"
      >
        {activeTranscriptSession?.summary && (
          <p className="mb-3 rounded border border-border bg-background/40 p-2 text-xs text-secondary">
            {activeTranscriptSession.summary}
          </p>
        )}
        {activeTranscriptSession?.transcript && activeTranscriptSession.transcript.length > 0 ? (
          <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto text-sm">
            {activeTranscriptSession.transcript.map((line, i) => (
              <li key={i} className={line.role === "agent" ? "text-cyan" : "text-primary"}>
                <span className="text-xs uppercase text-tertiary">{line.role}</span>
                <p>{line.text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-tertiary">No transcript recorded for this call.</p>
        )}
        {activeTranscriptSession?.outcome && (
          <p className="mt-3 text-xs text-tertiary">Outcome: {activeTranscriptSession.outcome}</p>
        )}
      </Dialog>
    </div>
  );
}
