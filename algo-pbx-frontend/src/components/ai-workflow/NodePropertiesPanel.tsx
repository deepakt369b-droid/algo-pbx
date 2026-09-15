"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Select, Switch } from "@/components/ui";
import type { VariableSpec, WorkflowNode } from "@/lib/ai/workflow-schema";
import { LegPicker, VoicePicker, type Credential } from "@/components/ai-agents/leg-pickers";

interface HumanExtensionRow {
  id: string;
  number: string;
  user: { name: string | null } | null;
}

// Right-hand slide-over: label, prompt, interruption toggle, variables
// editor, kind-specific fields (Transfer target / HTTP request shape), and
// a collapsed "Model overrides" section reusing the same LegPicker/
// VoicePicker the agent editor uses for its top-level legs — a node
// override is resolved server-side the exact same way (see
// agent-config/route.ts's resolveWorkflowRuntime()).
export function NodePropertiesPanel({
  node,
  credentials,
  humanExtensions,
  onChange,
  onDelete,
  onClose,
}: {
  node: WorkflowNode | null;
  credentials: Credential[];
  humanExtensions: HumanExtensionRow[];
  onChange: (updated: WorkflowNode) => void;
  onDelete: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [showOverrides, setShowOverrides] = useState(false);

  if (!node) return null;

  const patch = (partial: Partial<WorkflowNode>) => onChange({ ...node, ...partial } as WorkflowNode);

  const addVariable = () => {
    const v: VariableSpec = { name: `var_${node.variables.length + 1}`, type: "string", prompt: "" };
    patch({ variables: [...node.variables, v] });
  };
  const updateVariable = (index: number, partial: Partial<VariableSpec>) => {
    const next = node.variables.map((v, i) => (i === index ? { ...v, ...partial } : v));
    patch({ variables: next });
  };
  const removeVariable = (index: number) => {
    patch({ variables: node.variables.filter((_, i) => i !== index) });
  };

  const selectedCredential = credentials.find((c) => c.id === node.modelOverride.llmProviderId);
  const selectedTtsCredential = credentials.find((c) => c.id === node.modelOverride.ttsProviderId);

  return (
    <div className="glass-card absolute right-4 top-4 z-10 flex max-h-[calc(100%-2rem)] w-80 flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-secondary">{node.kind.replace("_", " ")}</p>
        <button onClick={onClose} className="text-tertiary hover:text-primary">
          <X size={16} />
        </button>
      </div>

      <label className="mb-3 flex flex-col gap-1 text-xs text-secondary">
        Label
        <input
          value={node.label}
          onChange={(e) => patch({ label: e.target.value })}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
        />
      </label>

      {node.kind !== "HTTP_TOOL" && (
        <label className="mb-3 flex flex-col gap-1 text-xs text-secondary">
          Prompt
          <textarea
            value={node.prompt}
            onChange={(e) => patch({ prompt: e.target.value })}
            rows={5}
            placeholder={
              node.kind === "GLOBAL"
                ? "Always-active instructions, prepended on every node."
                : node.kind === "END_CALL"
                  ? "The farewell message spoken when the call reaches this node."
                  : "What the AI should do at this step."
            }
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>
      )}

      {node.kind !== "GLOBAL" && (
        <label className="mb-3 flex items-center justify-between gap-2 text-xs text-secondary">
          Allow interruption
          <Switch
            checked={node.allowInterruption}
            onChange={(v) => patch({ allowInterruption: v })}
            label={node.allowInterruption ? "Allowed" : "Disabled"}
          />
        </label>
      )}

      {(node.kind === "AGENT" || node.kind === "GLOBAL" || node.kind === "START_CALL") && (
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-secondary">Variables to extract</p>
            <button onClick={addVariable} className="text-xs text-cyan hover:underline">
              + Add
            </button>
          </div>
          {node.variables.map((v, i) => (
            <div key={i} className="flex flex-col gap-1 rounded-lg border border-border p-2">
              <div className="flex gap-1.5">
                <input
                  value={v.name}
                  onChange={(e) => updateVariable(i, { name: e.target.value })}
                  placeholder="variable_name"
                  className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-primary outline-none focus:border-cyan"
                />
                <Select
                  aria-label="Variable type"
                  value={v.type}
                  onChange={(t) => updateVariable(i, { type: t as VariableSpec["type"] })}
                  options={[
                    { value: "string", label: "string" },
                    { value: "number", label: "number" },
                    { value: "boolean", label: "boolean" },
                  ]}
                  className="w-24"
                />
                <button onClick={() => removeVariable(i)} className="text-tertiary hover:text-danger">
                  <X size={14} />
                </button>
              </div>
              <input
                value={v.prompt}
                onChange={(e) => updateVariable(i, { prompt: e.target.value })}
                placeholder="What should the AI extract?"
                className="rounded border border-border bg-background px-2 py-1 text-xs text-primary outline-none focus:border-cyan"
              />
            </div>
          ))}
        </div>
      )}

      {node.kind === "TRANSFER" && (
        <div className="mb-3 flex flex-col gap-2">
          <p className="text-xs font-medium text-secondary">Transfer target</p>
          <Select
            aria-label="Transfer target kind"
            value={node.transferTargetKind ?? "none"}
            onChange={(v) =>
              patch({ transferTargetKind: v === "none" ? null : (v as "NUMBER" | "EXTENSION" | "AGENT_DEFAULT") })
            }
            options={[
              { value: "none", label: "Not set" },
              { value: "AGENT_DEFAULT", label: "Use the agent's own escalation target" },
              { value: "NUMBER", label: "Phone number (dials out over the GSM trunk)" },
              { value: "EXTENSION", label: "Internal extension" },
            ]}
          />
          {node.transferTargetKind === "NUMBER" && (
            <input
              value={node.transferNumberE164 ?? ""}
              onChange={(e) => patch({ transferNumberE164: e.target.value || null })}
              placeholder="+971500000000"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
            />
          )}
          {node.transferTargetKind === "EXTENSION" && (
            <Select
              aria-label="Transfer extension"
              value={node.transferExtensionId}
              onChange={(v) => patch({ transferExtensionId: v })}
              placeholder="Choose an extension…"
              options={humanExtensions.map((e) => ({
                value: e.id,
                label: e.user?.name ? `${e.number} — ${e.user.name}` : e.number,
              }))}
            />
          )}
          <p className="text-[11px] text-tertiary">
            Only 1 Dinstar SIM is active today — a NUMBER transfer during an inbound GSM call can hit the trunk&apos;s
            single-channel limit. See LLM.md §34.2.
          </p>
        </div>
      )}

      {node.kind === "HTTP_TOOL" && (
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <Select
              aria-label="HTTP method"
              value={node.method}
              onChange={(v) => patch({ method: v as Extract<WorkflowNode, { kind: "HTTP_TOOL" }>["method"] })}
              options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))}
              className="w-28"
            />
            <input
              value={node.urlTemplate}
              onChange={(e) => patch({ urlTemplate: e.target.value })}
              placeholder="https://api.example.com/orders/{{gathered_context.orderId}}"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs text-primary outline-none focus:border-cyan"
            />
          </div>
          <textarea
            value={node.bodyTemplate ?? ""}
            onChange={(e) => patch({ bodyTemplate: e.target.value || null })}
            placeholder='Request body (JSON), e.g. {"order_id": "{{gathered_context.orderId}}"}'
            rows={3}
            className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-primary outline-none focus:border-cyan"
          />
          <label className="flex flex-col gap-1 text-xs text-secondary">
            Timeout (ms)
            <input
              type="number"
              min={500}
              max={10000}
              value={node.timeoutMs}
              onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
            />
          </label>
          <p className="text-[11px] text-tertiary">
            Secrets referenced as <code>{"{{secrets.NAME}}"}</code> are resolved server-side and never reach this
            sidecar or your browser.
          </p>
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-secondary">Response → variables</p>
            {node.responseMapping.map((m, i) => (
              <div key={i} className="flex gap-1.5">
                <input
                  value={m.jsonPath}
                  onChange={(e) => {
                    const next = node.responseMapping.map((r, idx) => (idx === i ? { ...r, jsonPath: e.target.value } : r));
                    patch({ responseMapping: next });
                  }}
                  placeholder="data.status"
                  className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-primary outline-none focus:border-cyan"
                />
                <input
                  value={m.intoVariable}
                  onChange={(e) => {
                    const next = node.responseMapping.map((r, idx) =>
                      idx === i ? { ...r, intoVariable: e.target.value } : r,
                    );
                    patch({ responseMapping: next });
                  }}
                  placeholder="status"
                  className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-primary outline-none focus:border-cyan"
                />
                <button
                  onClick={() => patch({ responseMapping: node.responseMapping.filter((_, idx) => idx !== i) })}
                  className="text-tertiary hover:text-danger"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              onClick={() => patch({ responseMapping: [...node.responseMapping, { jsonPath: "", intoVariable: "" }] })}
              className="text-left text-xs text-cyan hover:underline"
            >
              + Map a field
            </button>
          </div>
        </div>
      )}

      {node.kind !== "HTTP_TOOL" && node.kind !== "GLOBAL" && (
        <div className="border-t border-border pt-3">
          <button
            onClick={() => setShowOverrides((v) => !v)}
            className="text-xs font-medium text-secondary hover:text-cyan"
          >
            {showOverrides ? "▾" : "▸"} Model overrides (optional)
          </button>
          {showOverrides && (
            <div className="mt-2 flex flex-col gap-3">
              <LegPicker
                leg="llm"
                label="LLM override"
                credentials={credentials}
                providerId={node.modelOverride.llmProviderId ?? null}
                model={node.modelOverride.llmModel ?? null}
                onChange={(providerId, model) =>
                  patch({ modelOverride: { ...node.modelOverride, llmProviderId: providerId, llmModel: model } })
                }
              />
              <label className="flex flex-col gap-1 text-xs text-secondary">
                Temperature (blank = agent default)
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={node.modelOverride.temperature ?? ""}
                  onChange={(e) =>
                    patch({
                      modelOverride: {
                        ...node.modelOverride,
                        temperature: e.target.value === "" ? null : Number(e.target.value),
                      },
                    })
                  }
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
                />
              </label>
              {selectedCredential && (
                <p className="text-[10px] text-tertiary">Using {selectedCredential.label} for this node&apos;s LLM.</p>
              )}
              <LegPicker
                leg="tts"
                label="TTS override"
                credentials={credentials}
                providerId={node.modelOverride.ttsProviderId ?? null}
                model={node.modelOverride.ttsModel ?? null}
                onChange={(providerId, model) =>
                  patch({ modelOverride: { ...node.modelOverride, ttsProviderId: providerId, ttsModel: model } })
                }
              />
              <VoicePicker
                credential={selectedTtsCredential}
                voice={node.modelOverride.ttsVoice ?? null}
                speed={node.modelOverride.ttsSpeed ?? null}
                onVoiceChange={(v) => patch({ modelOverride: { ...node.modelOverride, ttsVoice: v } })}
                onSpeedChange={(s) => patch({ modelOverride: { ...node.modelOverride, ttsSpeed: s } })}
              />
            </div>
          )}
        </div>
      )}

      {node.kind !== "START_CALL" && (
        <button
          onClick={() => onDelete(node.id)}
          className="mt-4 rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger-subtle"
        >
          Delete node
        </button>
      )}
    </div>
  );
}
