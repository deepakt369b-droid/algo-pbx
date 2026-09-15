"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui";
import type { WorkflowEdge } from "@/lib/ai/workflow-schema";

// Edits one edge's `condition` string — the entire mechanism by which the
// AI decides which path to take (see workflow-schema.ts's own comment on
// WorkflowEdgeSchema.condition and pipeline/workflow.py's pathway_tools()).
export function EdgeConditionDialog({
  edge,
  onSave,
  onDelete,
  onClose,
}: {
  edge: WorkflowEdge | null;
  onSave: (edgeId: string, condition: string) => void;
  onDelete: (edgeId: string) => void;
  onClose: () => void;
}) {
  // Seeded from `edge.condition` on mount; the parent remounts this
  // component per edge via `key={edge.id}` so a different edge always
  // starts with a fresh draft rather than the previous edge's leftover text.
  const [condition, setCondition] = useState(edge?.condition ?? "");

  return (
    <Dialog
      open={edge !== null}
      onClose={onClose}
      title="Edge condition"
      description="This text is what the AI reads to decide when to take this path."
      size="sm"
    >
      {edge && (
        <div className="flex flex-col gap-3">
          <textarea
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            rows={3}
            placeholder='e.g. "Caller wants to speak to a human" or "Caller confirmed their order"'
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
            autoFocus
          />
          <div className="flex items-center justify-between">
            <button
              onClick={() => onDelete(edge.id)}
              className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger-subtle"
            >
              Delete edge
            </button>
            <div className="flex gap-2">
              <button onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-xs text-secondary">
                Cancel
              </button>
              <button
                onClick={() => condition.trim() && onSave(edge.id, condition.trim())}
                disabled={!condition.trim()}
                className="rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
