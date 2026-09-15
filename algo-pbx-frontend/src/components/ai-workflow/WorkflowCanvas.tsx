"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type OnNodeDrag,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./workflow-canvas.css";
import { apiFetch, ApiError } from "@/lib/client/api";
import {
  AI_WORKFLOW_SCHEMA_VERSION,
  validateWorkflowGraph,
  type AiWorkflowGraph,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowValidationIssue,
} from "@/lib/ai/workflow-schema";
import type { Credential } from "@/components/ai-agents/leg-pickers";
import { nodeTypes, type AiWorkflowNodeData } from "./nodes";
import { NodePropertiesPanel } from "./NodePropertiesPanel";
import { EdgeConditionDialog } from "./EdgeConditionDialog";
import { ValidationPanel } from "./ValidationPanel";
import { PublishBar, type WorkflowVersionRow } from "./PublishBar";

function genId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function toRfNodes(nodes: WorkflowNode[], invalidIds: Set<string>, onOpen: (id: string) => void): Node[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: node.position,
    data: { node, invalid: invalidIds.has(node.id), onOpen } satisfies AiWorkflowNodeData,
  }));
}

function toRfEdges(edges: WorkflowEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.condition,
    labelStyle: { fill: "rgb(var(--text-secondary))", fontSize: 10 },
    style: { stroke: "rgb(var(--text-tertiary))" },
  }));
}

function newNode(kind: WorkflowNode["kind"], position: { x: number; y: number }): WorkflowNode {
  const base = {
    id: genId(),
    label: kind.replace("_", " "),
    position,
    prompt: "",
    allowInterruption: true,
    variables: [],
    modelOverride: {},
  };
  if (kind === "TRANSFER") {
    return { ...base, kind, transferTargetKind: null, transferNumberE164: null, transferExtensionId: null };
  }
  if (kind === "HTTP_TOOL") {
    return {
      ...base,
      kind,
      method: "GET",
      urlTemplate: "",
      headers: [],
      bodyTemplate: null,
      timeoutMs: 5000,
      responseMapping: [],
    };
  }
  return { ...base, kind };
}

const ADDABLE_KINDS: { kind: WorkflowNode["kind"]; label: string }[] = [
  { kind: "AGENT", label: "+ Agent" },
  { kind: "END_CALL", label: "+ End Call" },
  { kind: "TRANSFER", label: "+ Transfer" },
  { kind: "GLOBAL", label: "+ Global" },
  { kind: "HTTP_TOOL", label: "+ HTTP Tool" },
];

interface HumanExtensionRow {
  id: string;
  number: string;
  user: { name: string | null } | null;
}

export function WorkflowCanvas({
  agentId,
  agentName,
  extensionNumber,
  initialDraft,
  initialPublishedVersion,
  initialVersions,
  credentials,
  humanExtensions,
}: {
  agentId: string;
  agentName: string;
  extensionNumber: string | null;
  initialDraft: AiWorkflowGraph;
  initialPublishedVersion: WorkflowVersionRow | null;
  initialVersions: WorkflowVersionRow[];
  credentials: Credential[];
  humanExtensions: HumanExtensionRow[];
}) {
  const domainNodesRef = useRef<Map<string, WorkflowNode>>(new Map(initialDraft.nodes.map((n) => [n.id, n])));
  const domainEdgesRef = useRef<Map<string, WorkflowEdge>>(new Map(initialDraft.edges.map((e) => [e.id, e])));
  const [issues, setIssues] = useState<WorkflowValidationIssue[]>(() =>
    validateWorkflowGraph(initialDraft.nodes, initialDraft.edges),
  );
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const [openEdgeId, setOpenEdgeId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [publishing, setPublishing] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState(initialPublishedVersion);
  const [versions, setVersions] = useState(initialVersions);
  const [publishError, setPublishError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidIds = useMemo(() => new Set(issues.filter((i) => i.path).map((i) => i.path)), [issues]);
  const openNode = openNodeId ? (domainNodesRef.current.get(openNodeId) ?? null) : null;
  const openEdge = openEdgeId ? (domainEdgesRef.current.get(openEdgeId) ?? null) : null;

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(
    toRfNodes(initialDraft.nodes, invalidIds, (id) => setOpenNodeId(id)),
  );
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(toRfEdges(initialDraft.edges));

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveState("saving");
      const graph: AiWorkflowGraph = {
        schemaVersion: AI_WORKFLOW_SCHEMA_VERSION,
        nodes: [...domainNodesRef.current.values()],
        edges: [...domainEdgesRef.current.values()],
      };
      try {
        const result = await apiFetch<{ ok: boolean; issues: WorkflowValidationIssue[] }>(
          `/api/admin/ai/agents/${agentId}/workflow`,
          { method: "PUT", body: graph },
        );
        setIssues(result.issues);
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 1500);
  }, [agentId]);

  const syncFromDomain = useCallback(() => {
    const nodes = [...domainNodesRef.current.values()];
    const edges = [...domainEdgesRef.current.values()];
    const nextIssues = validateWorkflowGraph(nodes, edges);
    setIssues(nextIssues);
    const invalid = new Set(nextIssues.filter((i) => i.path).map((i) => i.path));
    setRfNodes(toRfNodes(nodes, invalid, (id) => setOpenNodeId(id)));
    setRfEdges(toRfEdges(edges));
    scheduleSave();
  }, [scheduleSave, setRfNodes, setRfEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const edge: WorkflowEdge = {
        id: genId(),
        source: connection.source as string,
        target: connection.target as string,
        condition: "always",
      };
      domainEdgesRef.current.set(edge.id, edge);
      setRfEdges((eds) => addEdge({ ...connection, id: edge.id, label: edge.condition }, eds));
      syncFromDomain();
      setOpenEdgeId(edge.id);
    },
    [setRfEdges, syncFromDomain],
  );

  const onNodeDragStop: OnNodeDrag<Node> = useCallback((_evt, node) => {
    const existing = domainNodesRef.current.get(node.id);
    if (existing) domainNodesRef.current.set(node.id, { ...existing, position: node.position });
    scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onEdgeClick: EdgeMouseHandler = useCallback((_evt, edge) => setOpenEdgeId(edge.id), []);

  const addNodeOfKind = (kind: WorkflowNode["kind"]) => {
    const node = newNode(kind, { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 });
    domainNodesRef.current.set(node.id, node);
    syncFromDomain();
    setOpenNodeId(node.id);
  };

  const updateNode = (updated: WorkflowNode) => {
    domainNodesRef.current.set(updated.id, updated);
    syncFromDomain();
  };

  const deleteNode = (nodeId: string) => {
    domainNodesRef.current.delete(nodeId);
    for (const [id, edge] of domainEdgesRef.current) {
      if (edge.source === nodeId || edge.target === nodeId) domainEdgesRef.current.delete(id);
    }
    setOpenNodeId(null);
    syncFromDomain();
  };

  const saveEdgeCondition = (edgeId: string, condition: string) => {
    const existing = domainEdgesRef.current.get(edgeId);
    if (existing) domainEdgesRef.current.set(edgeId, { ...existing, condition });
    setOpenEdgeId(null);
    syncFromDomain();
  };

  const deleteEdge = (edgeId: string) => {
    domainEdgesRef.current.delete(edgeId);
    setOpenEdgeId(null);
    syncFromDomain();
  };

  const focusNode = (nodeId: string) => setOpenNodeId(nodeId);

  const publish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await apiFetch<{ ok: boolean; publishedVersion: number; issues?: WorkflowValidationIssue[] }>(
        `/api/admin/ai/agents/${agentId}/workflow/publish`,
        { method: "POST", body: {} },
      );
      const versionsResp = await apiFetch<{ versions: WorkflowVersionRow[]; publishedVersion: WorkflowVersionRow | null }>(
        `/api/admin/ai/agents/${agentId}/workflow`,
      );
      setPublishedVersion(versionsResp.publishedVersion);
      setVersions(versionsResp.versions);
      if (result.issues) setIssues(result.issues);
    } catch (err) {
      setPublishError(err instanceof ApiError ? err.message : "Publish failed.");
    } finally {
      setPublishing(false);
    }
  };

  const revert = async (versionId: string) => {
    setPublishing(true);
    setPublishError(null);
    try {
      await apiFetch(`/api/admin/ai/agents/${agentId}/workflow/publish`, {
        method: "POST",
        body: { revertToVersionId: versionId },
      });
      const versionsResp = await apiFetch<{ versions: WorkflowVersionRow[]; publishedVersion: WorkflowVersionRow | null }>(
        `/api/admin/ai/agents/${agentId}/workflow`,
      );
      setPublishedVersion(versionsResp.publishedVersion);
      setVersions(versionsResp.versions);
    } catch (err) {
      setPublishError(err instanceof ApiError ? err.message : "Revert failed.");
    } finally {
      setPublishing(false);
    }
  };

  const hasBlockingIssues = issues.some((i) => i.severity === "error");

  return (
    <div className="flex h-full w-full flex-col">
      <PublishBar
        agentName={agentName}
        extensionNumber={extensionNumber}
        saveState={saveState}
        hasBlockingIssues={hasBlockingIssues}
        publishedVersion={publishedVersion}
        versions={versions}
        publishing={publishing}
        onPublish={publish}
        onRevert={revert}
      />
      {publishError && <p className="bg-danger-subtle px-4 py-1.5 text-xs text-danger">{publishError}</p>}
      <div className="flex flex-1 gap-2 border-b border-border bg-surface-subtle px-4 py-2">
        {ADDABLE_KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            onClick={() => addNodeOfKind(kind)}
            className="rounded-lg border border-border px-2 py-1 text-xs text-secondary hover:border-cyan hover:text-cyan"
          >
            {label}
          </button>
        ))}
      </div>
      <div className="relative flex-1">
        <ReactFlow
          className="ai-workflow-canvas"
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onEdgeClick={onEdgeClick}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
        <ValidationPanel issues={issues} onFocusNode={focusNode} />
        <NodePropertiesPanel
          node={openNode}
          credentials={credentials}
          humanExtensions={humanExtensions}
          onChange={updateNode}
          onDelete={deleteNode}
          onClose={() => setOpenNodeId(null)}
        />
        <EdgeConditionDialog
          key={openEdge?.id ?? "none"}
          edge={openEdge}
          onSave={saveEdgeCondition}
          onDelete={deleteEdge}
          onClose={() => setOpenEdgeId(null)}
        />
      </div>
    </div>
  );
}
