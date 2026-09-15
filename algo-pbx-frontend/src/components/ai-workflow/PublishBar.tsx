"use client";

import { Select } from "@/components/ui";

export interface WorkflowVersionRow {
  id: string;
  version: number;
  publishedAt: string;
}

export function PublishBar({
  agentName,
  extensionNumber,
  saveState,
  hasBlockingIssues,
  publishedVersion,
  versions,
  publishing,
  onPublish,
  onRevert,
}: {
  agentName: string;
  extensionNumber: string | null;
  saveState: "idle" | "saving" | "saved" | "error";
  hasBlockingIssues: boolean;
  publishedVersion: WorkflowVersionRow | null;
  versions: WorkflowVersionRow[];
  publishing: boolean;
  onPublish: () => void;
  onRevert: (versionId: string) => void;
}) {
  const saveLabel = { idle: "", saving: "Saving draft…", saved: "Draft saved", error: "Save failed" }[saveState];

  return (
    <div className="flex w-full items-center justify-between border-b border-border bg-surface px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-primary">{agentName}</span>
        <span className="text-xs text-tertiary">ext. {extensionNumber ?? "—"}</span>
        <span className="text-xs text-tertiary">·</span>
        <span className="text-xs text-tertiary">
          {publishedVersion ? `Published v${publishedVersion.version}` : "Never published"}
        </span>
        {saveLabel && (
          <span className={`text-xs ${saveState === "error" ? "text-danger" : "text-tertiary"}`}>{saveLabel}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {versions.length > 1 && (
          <Select
            aria-label="Revert to version"
            value={null}
            onChange={(v) => v && onRevert(v)}
            placeholder="Revert to…"
            options={versions.map((v) => ({
              value: v.id,
              label: `v${v.version} — ${new Date(v.publishedAt).toLocaleString()}`,
            }))}
            className="w-56"
          />
        )}
        <button
          onClick={onPublish}
          disabled={hasBlockingIssues || publishing}
          className="rounded-lg bg-cyan px-4 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          title={hasBlockingIssues ? "Fix the blocking issues before publishing" : undefined}
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
      </div>
    </div>
  );
}
