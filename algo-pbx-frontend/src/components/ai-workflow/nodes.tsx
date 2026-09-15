"use client";

import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { Globe, MessageSquare, Network, PhoneForwarded, PhoneIncoming, PhoneOff } from "lucide-react";
import type { WorkflowNode } from "@/lib/ai/workflow-schema";

// One glass-card-styled node component per WorkflowNode.kind. Kept in a
// single file (rather than nodes/StartCallNode.tsx, nodes/AgentNode.tsx,
// ...) — each is a small wrapper around the same GenericNode shell, and the
// only thing that varies is an icon/accent color/whether source-and-target
// handles both render, so five near-identical files would only add import
// overhead without adding clarity.

export interface AiWorkflowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  invalid: boolean;
  onOpen: (nodeId: string) => void;
}

const KIND_META: Record<WorkflowNode["kind"], { icon: typeof PhoneIncoming; accent: string }> = {
  START_CALL: { icon: PhoneIncoming, accent: "rgb(var(--accent))" },
  AGENT: { icon: MessageSquare, accent: "rgb(var(--text-secondary))" },
  END_CALL: { icon: PhoneOff, accent: "rgb(var(--danger))" },
  TRANSFER: { icon: PhoneForwarded, accent: "rgb(var(--warning))" },
  GLOBAL: { icon: Globe, accent: "rgb(var(--accent))" },
  HTTP_TOOL: { icon: Network, accent: "rgb(var(--success))" },
};

function GenericNode({ data, selected }: NodeProps) {
  const { node, invalid, onOpen } = data as unknown as AiWorkflowNodeData;
  const { icon: Icon, accent } = KIND_META[node.kind];
  const showTarget = node.kind !== "START_CALL";
  const showSource = node.kind !== "END_CALL" && node.kind !== "TRANSFER" && node.kind !== "GLOBAL";

  return (
    <div
      className="ai-workflow-node"
      data-invalid={invalid}
      data-selected={selected}
      style={{ borderLeftWidth: 3, borderLeftColor: accent }}
      onDoubleClick={() => onOpen(node.id)}
    >
      {showTarget && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-1.5">
        <Icon size={13} style={{ color: accent }} />
        <span className="truncate font-medium text-primary">{node.label}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] text-tertiary">
        {node.kind === "HTTP_TOOL" ? node.urlTemplate || "No URL set" : node.prompt || "No prompt set"}
      </p>
      {node.variables.length > 0 && (
        <p className="mt-1 text-[10px] text-tertiary">extracts: {node.variables.map((v) => v.name).join(", ")}</p>
      )}
      <button
        onClick={() => onOpen(node.id)}
        className="mt-2 w-full rounded border border-border py-0.5 text-[10px] text-secondary hover:border-cyan hover:text-cyan"
      >
        Edit
      </button>
      {showSource && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  START_CALL: GenericNode,
  AGENT: GenericNode,
  END_CALL: GenericNode,
  TRANSFER: GenericNode,
  GLOBAL: GenericNode,
  HTTP_TOOL: GenericNode,
};
