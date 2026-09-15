"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/client/api";
import { Switch, Select, type SelectOption } from "@/components/ui";
import { AI_LANGUAGES } from "@/lib/ai/languages";
import { LegPicker, VoicePicker, type Credential } from "@/components/ai-agents/leg-pickers";

interface AgentDetail {
  id: string;
  name: string;
  language: string;
  greeting: string;
  systemPrompt: string;
  pipelineMode: "REALTIME" | "CASCADE";
  realtimeProviderId: string | null;
  realtimeModel: string | null;
  sttProviderId: string | null;
  sttModel: string | null;
  llmProviderId: string | null;
  llmModel: string | null;
  ttsProviderId: string | null;
  ttsModel: string | null;
  ttsVoice: string | null;
  allowedDestinations: string[];
  callHoursStart: number | null;
  callHoursEnd: number | null;
  outboundEnabled: boolean;
  dinstarPort: number | null;
  // AI -> human escalation (LLM.md §34.2, 2026-09-14). handoffTargetKind
  // selects which of handoffNumberE164/handoffExtensionId is authoritative;
  // see the API route's UpdateAgentSchema comment for why the other is left
  // as-is rather than force-cleared on save.
  escalationEnabled: boolean;
  handoffTargetKind: "NUMBER" | "EXTENSION" | null;
  handoffNumberE164: string | null;
  handoffExtensionId: string | null;
  enabled: boolean;
  extension: { id: string; number: string } | null;
  // Conversation-workflow builder (2026-09-15). "WORKFLOW" only actually
  // takes effect once a graph is published at /admin/ai-agents/[id]/workflow
  // — see AiAgent.promptMode's schema comment.
  promptMode: "SIMPLE" | "WORKFLOW";
  // Model configuration (2026-09-15). All null = provider defaults, exactly
  // as before these fields existed.
  llmTemperature: number | null;
  llmMaxTokens: number | null;
  ttsSpeed: number | null;
  sttLanguage: string | null;
  allowInterruption: boolean;
  vadEnergyThreshold: number | null;
  vadSilenceFrames: number | null;
  bargeInThreshold: number | null;
  bargeInConsecutiveFrames: number | null;
}

// A same-tenant extension eligible as an escalation target — from
// GET /api/extensions (agentType is included there specifically so this
// picker can filter without a second endpoint). AI-kind extensions have no
// PJSIP registration to ring at all, so only HUMAN ones are offered.
interface HumanExtensionRow {
  id: string;
  number: string;
  agentType: string;
  user: { name: string | null } | null;
}

// List-row shape from GET /api/admin/ai/agents — used only to compute which
// OTHER agent (if any) already holds each GSM port, so the admin can see it
// in this select's labels before hitting the [id] route's 409 (follow-up to
// §34, LLM.md 2026-09-14).
interface AgentListRow {
  id: string;
  name: string;
  dinstarPort: number | null;
}

const DINSTAR_PORT_VALUES = ["none", "1", "2", "3", "4"] as const;

const LANGUAGE_OPTIONS: SelectOption<string>[] = AI_LANGUAGES.map((l) => ({ value: l.tag, label: l.label }));

const HOUR_OPTIONS: SelectOption<string>[] = [
  { value: "none", label: "No restriction" },
  ...Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` })),
];

export default function AiAgentEditorPage() {
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [otherAgents, setOtherAgents] = useState<AgentListRow[]>([]);
  const [humanExtensions, setHumanExtensions] = useState<HumanExtensionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [destinationInput, setDestinationInput] = useState("");

  const load = async () => {
    try {
      const [agentData, providerData, listData, extensionData] = await Promise.all([
        apiFetch<{ agent: AgentDetail }>(`/api/admin/ai/agents/${params.id}`),
        apiFetch<{ credentials: Credential[] }>("/api/admin/ai/providers"),
        apiFetch<{ agents: AgentListRow[] }>("/api/admin/ai/agents"),
        apiFetch<{ extensions: HumanExtensionRow[] }>("/api/extensions"),
      ]);
      setAgent(agentData.agent);
      setCredentials(providerData.credentials ?? []);
      setOtherAgents((listData.agents ?? []).filter((a) => a.id !== params.id));
      setHumanExtensions((extensionData.extensions ?? []).filter((e) => e.agentType === "HUMAN"));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load this AI agent.");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const save = async () => {
    if (!agent) return;
    setSaving(true);
    setMessage(null);
    try {
      const data = await apiFetch<{ agent: AgentDetail }>(`/api/admin/ai/agents/${agent.id}`, {
        method: "PATCH",
        body: {
          name: agent.name,
          language: agent.language,
          greeting: agent.greeting,
          systemPrompt: agent.systemPrompt,
          pipelineMode: agent.pipelineMode,
          realtimeProviderId: agent.realtimeProviderId,
          realtimeModel: agent.realtimeModel,
          sttProviderId: agent.sttProviderId,
          sttModel: agent.sttModel,
          llmProviderId: agent.llmProviderId,
          llmModel: agent.llmModel,
          ttsProviderId: agent.ttsProviderId,
          ttsModel: agent.ttsModel,
          ttsVoice: agent.ttsVoice,
          allowedDestinations: agent.allowedDestinations,
          callHoursStart: agent.callHoursStart,
          callHoursEnd: agent.callHoursEnd,
          outboundEnabled: agent.outboundEnabled,
          dinstarPort: agent.dinstarPort,
          escalationEnabled: agent.escalationEnabled,
          handoffTargetKind: agent.handoffTargetKind,
          handoffNumberE164: agent.handoffNumberE164,
          handoffExtensionId: agent.handoffExtensionId,
          enabled: agent.enabled,
          promptMode: agent.promptMode,
          llmTemperature: agent.llmTemperature,
          llmMaxTokens: agent.llmMaxTokens,
          ttsSpeed: agent.ttsSpeed,
          sttLanguage: agent.sttLanguage,
          allowInterruption: agent.allowInterruption,
        },
      });
      setAgent(data.agent);
      setMessage({ text: "Saved.", kind: "ok" });
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "Could not save changes.", kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  const addDestination = () => {
    const value = destinationInput.trim();
    if (!value || !agent) return;
    if (!agent.allowedDestinations.includes(value)) {
      setAgent({ ...agent, allowedDestinations: [...agent.allowedDestinations, value] });
    }
    setDestinationInput("");
  };

  const removeDestination = (value: string) => {
    if (!agent) return;
    setAgent({ ...agent, allowedDestinations: agent.allowedDestinations.filter((d) => d !== value) });
  };

  const hourValue = (h: number | null) => (h === null ? "none" : String(h));
  const parseHour = (v: string): number | null => (v === "none" ? null : Number(v));

  // Follow-up to §34 (LLM.md, 2026-09-14): label each port with whichever
  // OTHER agent already holds it, computed from this tenant's own AiAgent
  // list (GET /api/admin/ai/agents), so the admin doesn't have to guess
  // before hitting the [id] route's 409 on save.
  const portHolder = (port: number): AgentListRow | undefined => otherAgents.find((a) => a.dinstarPort === port);
  const dinstarPortOptions: SelectOption<(typeof DINSTAR_PORT_VALUES)[number]>[] = DINSTAR_PORT_VALUES.map((v) => {
    if (v === "none") return { value: v, label: "Not assigned to a GSM port (internal only)" };
    const holder = portHolder(Number(v));
    return { value: v, label: holder ? `Port ${v} — in use by ${holder.name}` : `Port ${v}` };
  });
  const dinstarPortValue = (p: number | null): (typeof DINSTAR_PORT_VALUES)[number] => (p === null ? "none" : (String(p) as (typeof DINSTAR_PORT_VALUES)[number]));
  const parseDinstarPort = (v: string): number | null => (v === "none" ? null : Number(v));

  // AI -> human escalation (LLM.md §34.2). "none" here means "no target
  // kind chosen yet", same "none" sentinel + parse/format pair convention
  // as dinstarPort/callHours above, since <Select> can't carry `null`
  // directly. Only 1 Dinstar SIM is active today (confirmed with the
  // owner) — a NUMBER target dialed against an inbound-GSM caller will hit
  // the trunk's single-channel limit (src/lib/transfer-guard.ts's
  // live-confirmed 503 trace) until more SIMs are active; the warning box
  // below surfaces this rather than hiding it.
  const HANDOFF_TARGET_VALUES = ["none", "NUMBER", "EXTENSION"] as const;
  const handoffTargetOptions: SelectOption<(typeof HANDOFF_TARGET_VALUES)[number]>[] = [
    { value: "none", label: "No escalation target configured" },
    { value: "NUMBER", label: "Phone number (dialed out over the GSM trunk)" },
    { value: "EXTENSION", label: "Internal extension (no GSM channel needed)" },
  ];
  const handoffTargetValue = (k: AgentDetail["handoffTargetKind"]): (typeof HANDOFF_TARGET_VALUES)[number] => k ?? "none";
  const parseHandoffTarget = (v: string): AgentDetail["handoffTargetKind"] => (v === "none" ? null : (v as "NUMBER" | "EXTENSION"));

  const HANDOFF_EXTENSION_SENTINEL = "none";
  const handoffExtensionOptions: SelectOption<string>[] = [
    { value: HANDOFF_EXTENSION_SENTINEL, label: "Choose an extension…" },
    ...humanExtensions.map((e) => ({
      value: e.id,
      label: e.user?.name ? `${e.number} — ${e.user.name}` : e.number,
    })),
  ];

  const isCascade = agent?.pipelineMode === "CASCADE";
  const isRealtime = agent?.pipelineMode === "REALTIME";

  const pageTitle = useMemo(() => agent?.name ?? "AI agent", [agent?.name]);

  if (loadError) {
    return (
      <div className="w-full max-w-2xl rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
        {loadError}
      </div>
    );
  }
  if (!agent) return <p className="text-tertiary">Loading…</p>;

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-xl font-semibold text-primary">
          {pageTitle} <span className="text-sm font-normal text-tertiary">· ext. {agent.extension?.number ?? "—"}</span>
        </h1>
        <Link href="/admin/ai-agents" className="text-xs text-cyan hover:underline">
          ← Back to AI agents
        </Link>
      </div>

      <div className="glass-card flex w-full max-w-2xl flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Basics</h2>
          <Switch checked={agent.enabled} onChange={(v) => setAgent({ ...agent, enabled: v })} label={agent.enabled ? "Enabled" : "Disabled"} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium text-primary">Conversation mode</p>
            <p className="text-xs text-tertiary">
              {agent.promptMode === "WORKFLOW"
                ? "A visual node graph drives this call — the System prompt below becomes shared context for every node."
                : "One flat prompt drives the whole call (today's default)."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {agent.promptMode === "WORKFLOW" && (
              <Link
                href={`/admin/ai-agents/${agent.id}/workflow`}
                className="rounded-lg border border-cyan px-2 py-1 text-xs text-cyan hover:bg-cyan/10"
              >
                Open workflow builder →
              </Link>
            )}
            <button
              onClick={() =>
                setAgent({ ...agent, promptMode: agent.promptMode === "WORKFLOW" ? "SIMPLE" : "WORKFLOW" })
              }
              className="rounded-lg border border-border px-2 py-1 text-xs text-secondary hover:border-cyan hover:text-cyan"
            >
              Switch to {agent.promptMode === "WORKFLOW" ? "Simple prompt" : "Workflow"}
            </button>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-xs text-secondary">
          Agent name
          <input
            value={agent.name}
            onChange={(e) => setAgent({ ...agent, name: e.target.value })}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-secondary">
          Language
          <Select
            aria-label="Language"
            value={agent.language}
            onChange={(v) => setAgent({ ...agent, language: v })}
            options={LANGUAGE_OPTIONS}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-secondary">
          GSM port (Dinstar UC2000)
          <Select
            aria-label="GSM port"
            value={dinstarPortValue(agent.dinstarPort)}
            onChange={(v) => setAgent({ ...agent, dinstarPort: parseDinstarPort(v) })}
            options={dinstarPortOptions}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-secondary">
          Greeting (always play the automated-call disclosure — compliance requirement)
          <textarea
            value={agent.greeting}
            onChange={(e) => setAgent({ ...agent, greeting: e.target.value })}
            rows={2}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-secondary">
          System prompt
          <textarea
            value={agent.systemPrompt}
            onChange={(e) => setAgent({ ...agent, systemPrompt: e.target.value })}
            rows={6}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>
      </div>

      <div className="glass-card flex w-full max-w-2xl flex-col gap-4 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Pipeline</h2>
        <div className="flex gap-2 text-xs">
          {(["REALTIME", "CASCADE"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setAgent({ ...agent, pipelineMode: m })}
              className={`flex-1 rounded-lg border px-2 py-1.5 ${agent.pipelineMode === m ? "border-cyan text-cyan" : "border-border text-secondary"}`}
            >
              {m === "REALTIME" ? "Realtime (one speech-to-speech model)" : "Cascade (STT → LLM → TTS)"}
            </button>
          ))}
        </div>

        {isRealtime && (
          <LegPicker
            leg="realtime"
            label="Realtime model"
            credentials={credentials}
            providerId={agent.realtimeProviderId}
            model={agent.realtimeModel}
            onChange={(providerId, model) => setAgent({ ...agent, realtimeProviderId: providerId, realtimeModel: model })}
          />
        )}

        {isCascade && (
          <>
            <LegPicker
              leg="stt"
              label="Speech-to-text"
              credentials={credentials}
              providerId={agent.sttProviderId}
              model={agent.sttModel}
              onChange={(providerId, model) => setAgent({ ...agent, sttProviderId: providerId, sttModel: model })}
            />
            <LegPicker
              leg="llm"
              label="LLM"
              credentials={credentials}
              providerId={agent.llmProviderId}
              model={agent.llmModel}
              onChange={(providerId, model) => setAgent({ ...agent, llmProviderId: providerId, llmModel: model })}
            />
            <LegPicker
              leg="tts"
              label="Text-to-speech"
              credentials={credentials}
              providerId={agent.ttsProviderId}
              model={agent.ttsModel}
              onChange={(providerId, model) => setAgent({ ...agent, ttsProviderId: providerId, ttsModel: model })}
            />
            <VoicePicker
              credential={credentials.find((c) => c.id === agent.ttsProviderId)}
              voice={agent.ttsVoice}
              speed={agent.ttsSpeed}
              onVoiceChange={(v) => setAgent({ ...agent, ttsVoice: v })}
              onSpeedChange={(s) => setAgent({ ...agent, ttsSpeed: s })}
            />
          </>
        )}
      </div>

      <div className="glass-card flex w-full max-w-2xl flex-col gap-4 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Model tuning</h2>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-xs text-secondary">
            LLM temperature (0–2, blank = provider default)
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={agent.llmTemperature ?? ""}
              onChange={(e) => setAgent({ ...agent, llmTemperature: e.target.value === "" ? null : Number(e.target.value) })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-secondary">
            LLM max tokens (blank = provider default)
            <input
              type="number"
              min={16}
              max={8192}
              step={1}
              value={agent.llmMaxTokens ?? ""}
              onChange={(e) => setAgent({ ...agent, llmMaxTokens: e.target.value === "" ? null : Number(e.target.value) })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
            />
          </label>
        </div>
        <label className="flex items-center justify-between gap-2 text-xs text-secondary">
          Allow the caller to interrupt the agent while it&apos;s speaking
          <Switch
            checked={agent.allowInterruption}
            onChange={(v) => setAgent({ ...agent, allowInterruption: v })}
            label={agent.allowInterruption ? "Allowed" : "Disabled"}
          />
        </label>
        <p className="text-xs text-tertiary">
          Disabling interruption is mainly for a fixed compliance disclosure — the caller can&apos;t talk over it until
          it finishes.
        </p>
      </div>

      <div className="glass-card flex w-full max-w-2xl flex-col gap-4 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Compliance &amp; calling policy</h2>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-secondary">Allowed outbound destinations (E.164 prefixes)</p>
          <div className="flex flex-wrap gap-1.5">
            {agent.allowedDestinations.map((d) => (
              <span key={d} className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-primary">
                {d}
                <button onClick={() => removeDestination(d)} className="text-tertiary hover:text-danger">
                  ×
                </button>
              </span>
            ))}
            {agent.allowedDestinations.length === 0 && (
              <span className="text-xs text-tertiary">Empty = inbound-answer only, no outbound dialing.</span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={destinationInput}
              onChange={(e) => setDestinationInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDestination();
                }
              }}
              placeholder="e.g. +971 or +91"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
            />
            <button onClick={addDestination} className="rounded-lg border border-cyan px-3 py-2 text-xs text-cyan hover:bg-cyan/10">
              Add
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs text-secondary">
            Call hours start
            <Select
              aria-label="Call hours start"
              value={hourValue(agent.callHoursStart)}
              onChange={(v) => setAgent({ ...agent, callHoursStart: parseHour(v) })}
              options={HOUR_OPTIONS}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-secondary">
            Call hours end
            <Select
              aria-label="Call hours end"
              value={hourValue(agent.callHoursEnd)}
              onChange={(v) => setAgent({ ...agent, callHoursEnd: parseHour(v) })}
              options={HOUR_OPTIONS}
            />
          </label>
        </div>

        <div className="flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <Switch
            checked={agent.outboundEnabled}
            onChange={(v) => setAgent({ ...agent, outboundEnabled: v })}
            label="Allow this agent to originate outbound calls"
          />
          <p className="text-xs text-warning">
            Ships off for a reason: automated outbound dialing over the GSM gateway carries real compliance
            risk (unsolicited/robocall regulations). Only enable this if you have confirmed the destination
            list and call hours above are correct, and that this use case is actually compliant in the
            destination country.
          </p>
        </div>
      </div>

      <div className="glass-card flex w-full max-w-2xl flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Escalation to a human</h2>
          <Switch
            checked={agent.escalationEnabled}
            onChange={(v) => setAgent({ ...agent, escalationEnabled: v })}
            label={agent.escalationEnabled ? "Enabled" : "Disabled"}
          />
        </div>
        <p className="text-xs text-tertiary">
          When enabled, the caller can ask this agent to speak with a human — the AI holds the call, dials
          the target below, and stays on the line until both sides hang up. Off by default until a target is
          configured and confirmed.
        </p>

        <label className="flex flex-col gap-1 text-xs text-secondary">
          Escalation target
          <Select
            aria-label="Escalation target kind"
            value={handoffTargetValue(agent.handoffTargetKind)}
            onChange={(v) => setAgent({ ...agent, handoffTargetKind: parseHandoffTarget(v) })}
            options={handoffTargetOptions}
          />
        </label>

        {agent.handoffTargetKind === "NUMBER" && (
          <>
            <label className="flex flex-col gap-1 text-xs text-secondary">
              Phone number
              <input
                value={agent.handoffNumberE164 ?? ""}
                onChange={(e) => setAgent({ ...agent, handoffNumberE164: e.target.value || null })}
                placeholder="e.g. +971501234567"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
              />
            </label>
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="text-xs text-warning">
                Only 1 GSM SIM is active on this trunk today. Dialing this number while the AI is already on
                an inbound GSM call will fail — there is no spare channel to place a second outbound call on
                (a hardware limit, confirmed live). This will work reliably once more SIMs are active, or for
                calls that did not arrive over the GSM trunk in the first place.
              </p>
            </div>
          </>
        )}

        {agent.handoffTargetKind === "EXTENSION" && (
          <label className="flex flex-col gap-1 text-xs text-secondary">
            Human extension
            <Select
              aria-label="Escalation target extension"
              value={agent.handoffExtensionId ?? HANDOFF_EXTENSION_SENTINEL}
              onChange={(v) => setAgent({ ...agent, handoffExtensionId: v === HANDOFF_EXTENSION_SENTINEL ? null : v })}
              options={handoffExtensionOptions}
              disabled={humanExtensions.length === 0}
            />
            {humanExtensions.length === 0 && (
              <span className="text-xs text-tertiary">No human extensions provisioned for this tenant yet.</span>
            )}
          </label>
        )}
      </div>

      <div className="flex w-full max-w-2xl items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
          {saving ? "Saving…" : "Save changes"}
        </button>
        {message && <p className={`text-xs ${message.kind === "error" ? "text-danger" : "text-tertiary"}`}>{message.text}</p>}
      </div>
    </div>
  );
}
