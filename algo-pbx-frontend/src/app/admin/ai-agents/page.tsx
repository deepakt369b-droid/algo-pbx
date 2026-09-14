"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/client/api";
import { Switch } from "@/components/ui";

interface AgentRow {
  id: string;
  name: string;
  language: string;
  pipelineMode: "REALTIME" | "CASCADE";
  enabled: boolean;
  outboundEnabled: boolean;
  dinstarPort: number | null;
  extension: { id: string; number: string } | null;
}

interface SeatUsage {
  seatsTotal: number;
  seatsUsed: number;
  seatsAvailable: number;
}

// AI agents list — consumes the new GET/PATCH /api/admin/ai/agents[/[id]]
// routes this pass added (see that route's header for why it exists at
// all: no other node owns AiAgent read/write). Creation itself happens
// from /admin/users's Human|AI chooser, not here — this page only lists
// and links into the per-agent editor, matching the task's "collect just
// an agent name + extension number [in the chooser], then ... redirect/
// link into the AI agent editor" flow.
export default function AiAgentsPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [planHasAiAgents, setPlanHasAiAgents] = useState(true);
  const [seatUsage, setSeatUsage] = useState<SeatUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await apiFetch<{ agents: AgentRow[]; planHasAiAgents: boolean; seatUsage: SeatUsage }>(
        "/api/admin/ai/agents"
      );
      setAgents(data.agents ?? []);
      setPlanHasAiAgents(data.planHasAiAgents);
      setSeatUsage(data.seatUsage);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load AI agents.");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggleEnabled = async (agent: AgentRow) => {
    setTogglingId(agent.id);
    try {
      await apiFetch(`/api/admin/ai/agents/${agent.id}`, { method: "PATCH", body: { enabled: !agent.enabled } });
      load();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not update this agent.");
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">AI Agents</h1>

      {loadError && (
        <div className="w-full max-w-2xl rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
          {loadError}
        </div>
      )}

      {!planHasAiAgents && (
        <div className="w-full max-w-2xl rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-center text-xs text-warning">
          AI agents are not included on this tenant&apos;s current plan.
        </div>
      )}

      {seatUsage && (
        <p className="text-xs text-tertiary">
          Seats: {seatUsage.seatsUsed} / {seatUsage.seatsTotal} used
        </p>
      )}

      <div className="glass-card w-full max-w-2xl p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Configured agents</h2>
          <Link href="/admin/users" className="text-xs text-cyan hover:underline">
            + New AI agent (via Users)
          </Link>
        </div>

        {agents.length === 0 ? (
          <p className="text-tertiary">
            None yet. Create one from <Link href="/admin/users" className="text-cyan hover:underline">Users &amp; Agent Management</Link> by
            choosing &quot;AI&quot; when adding a new extension.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-tertiary">
              <tr>
                <th className="pb-2">Name</th>
                <th className="pb-2">Extension</th>
                <th className="pb-2">Language</th>
                <th className="pb-2">Pipeline</th>
                <th className="pb-2">GSM port</th>
                <th className="pb-2">Enabled</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody className="text-primary">
              {agents.map((agent) => (
                <tr key={agent.id} className="border-t border-border">
                  <td className="py-2">{agent.name}</td>
                  <td className="py-2">{agent.extension?.number ?? "—"}</td>
                  <td className="py-2">{agent.language}</td>
                  <td className="py-2">{agent.pipelineMode}</td>
                  <td className="py-2">{agent.dinstarPort ? `Port ${agent.dinstarPort}` : "—"}</td>
                  <td className="py-2">
                    <Switch checked={agent.enabled} onChange={() => toggleEnabled(agent)} disabled={togglingId === agent.id} />
                  </td>
                  <td className="py-2 text-right">
                    <Link href={`/admin/ai-agents/${agent.id}`} className="text-xs text-cyan hover:underline">
                      Configure
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
