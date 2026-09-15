"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/client/api";
import { AI_WORKFLOW_SCHEMA_VERSION, type AiWorkflowGraph } from "@/lib/ai/workflow-schema";
import type { Credential } from "@/components/ai-agents/leg-pickers";
import type { WorkflowVersionRow } from "@/components/ai-workflow/PublishBar";
import { WorkflowCanvas } from "@/components/ai-workflow/WorkflowCanvas";

// Dedicated full-bleed route for the visual workflow canvas — deliberately
// NOT another card on the agent editor page (src/app/admin/ai-agents/[id]/
// page.tsx, a max-w-2xl stacked form): a graph canvas needs the viewport,
// and the two pages are linked by a simple back-link + the editor's own
// "Open workflow builder" button (see that page's Basics card).

interface AgentSummary {
  id: string;
  name: string;
  extension: { number: string } | null;
}

interface WorkflowLoadResponse {
  draftGraph: AiWorkflowGraph;
  publishedVersion: WorkflowVersionRow | null;
  versions: WorkflowVersionRow[];
}

interface HumanExtensionRow {
  id: string;
  number: string;
  agentType: string;
  user: { name: string | null } | null;
}

const EMPTY_GRAPH: AiWorkflowGraph = { schemaVersion: AI_WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] };

export default function AiWorkflowPage() {
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowLoadResponse | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [humanExtensions, setHumanExtensions] = useState<HumanExtensionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [agentData, workflowData, providerData, extensionData] = await Promise.all([
          apiFetch<{ agent: AgentSummary }>(`/api/admin/ai/agents/${params.id}`),
          apiFetch<WorkflowLoadResponse>(`/api/admin/ai/agents/${params.id}/workflow`),
          apiFetch<{ credentials: Credential[] }>("/api/admin/ai/providers"),
          apiFetch<{ extensions: HumanExtensionRow[] }>("/api/extensions"),
        ]);
        setAgent(agentData.agent);
        setWorkflow(workflowData);
        setCredentials(providerData.credentials ?? []);
        setHumanExtensions((extensionData.extensions ?? []).filter((e) => e.agentType === "HUMAN"));
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : "Could not load this agent's workflow.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (loadError) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
          {loadError}
        </div>
      </div>
    );
  }
  if (!agent || !workflow) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-tertiary">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] w-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-1.5">
        <Link href={`/admin/ai-agents/${agent.id}`} className="text-xs text-cyan hover:underline">
          ← Back to {agent.name}
        </Link>
      </div>
      <div className="flex-1">
        <WorkflowCanvas
          agentId={agent.id}
          agentName={agent.name}
          extensionNumber={agent.extension?.number ?? null}
          initialDraft={workflow.draftGraph ?? EMPTY_GRAPH}
          initialPublishedVersion={workflow.publishedVersion}
          initialVersions={workflow.versions}
          credentials={credentials}
          humanExtensions={humanExtensions}
        />
      </div>
    </div>
  );
}
