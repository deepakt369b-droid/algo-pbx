"use client";

import { AlertTriangle, CircleAlert } from "lucide-react";
import type { WorkflowValidationIssue } from "@/lib/ai/workflow-schema";

// Bottom-left floating panel listing every validateWorkflowGraph() issue —
// errors block publish, warnings don't. Clicking an issue focuses the node
// it's about (a no-op for graph-level issues, whose `path` is "").
export function ValidationPanel({
  issues,
  onFocusNode,
}: {
  issues: WorkflowValidationIssue[];
  onFocusNode: (nodeId: string) => void;
}) {
  if (issues.length === 0) return null;
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return (
    <div className="glass-card absolute bottom-4 left-4 z-10 max-h-64 w-80 overflow-y-auto p-3">
      <p className="mb-2 text-xs font-semibold text-secondary">
        {errors.length > 0 ? `${errors.length} issue${errors.length === 1 ? "" : "s"} blocking publish` : "Warnings"}
      </p>
      <ul className="flex flex-col gap-1.5">
        {issues.map((issue, i) => (
          <li key={i}>
            <button
              onClick={() => issue.path && onFocusNode(issue.path)}
              className={`flex w-full items-start gap-1.5 rounded-lg px-2 py-1 text-left text-[11px] ${
                issue.path ? "hover:bg-surface-hover" : "cursor-default"
              }`}
            >
              {issue.severity === "error" ? (
                <CircleAlert size={12} className="mt-0.5 shrink-0 text-danger" />
              ) : (
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning" />
              )}
              <span className="text-secondary">{issue.message}</span>
            </button>
          </li>
        ))}
      </ul>
      {warnings.length > 0 && errors.length === 0 && (
        <p className="mt-2 text-[10px] text-tertiary">Warnings don&apos;t block publishing.</p>
      )}
    </div>
  );
}
