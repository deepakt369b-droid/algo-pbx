"use client";

// Shared provider/model/voice pickers for AI agent legs — used by the
// agent editor (src/app/admin/ai-agents/[id]/page.tsx) AND, from the
// workflow-builder plan onward, a workflow node's model-override panel
// (src/components/ai-workflow/NodePropertiesPanel.tsx). Factored out of the
// editor page so a page.tsx file doesn't need non-page named exports, which
// Next.js's App Router restricts.

import Link from "next/link";
import { Select } from "@/components/ui";
import type { AiModelInfo, AiProviderKind } from "@/lib/ai/types";

export interface Credential {
  id: string;
  provider: AiProviderKind;
  label: string;
  cachedModels: AiModelInfo[] | null;
}

// Which model capability each leg needs — used to filter a credential's
// cachedModels (AiModelInfo.capabilities, contracts.md) down to models
// actually usable for that leg, rather than listing every model a provider
// happens to expose.
export const LEG_CAPABILITY = { realtime: "realtime", stt: "stt", llm: "llm", tts: "tts" } as const;

export function modelsFor(credential: Credential | undefined, leg: keyof typeof LEG_CAPABILITY): AiModelInfo[] {
  if (!credential?.cachedModels) return [];
  const cap = LEG_CAPABILITY[leg];
  return credential.cachedModels.filter((m) => m.capabilities.includes(cap));
}

// Fixed 2026-09-15 (workflow-builder plan, blocker #7): voices are tagged
// "voice", distinctly from "tts" models — ElevenLabs/Cartesia/OpenAI all
// return entries with this capability now (see their adapters). A provider
// with no live voice list (Sarvam, Deepgram, azure, etc.) returns none, and
// the voice picker below falls back to a free-text input.
export function voicesFor(credential: Credential | undefined): AiModelInfo[] {
  if (!credential?.cachedModels) return [];
  return credential.cachedModels.filter((m) => m.capabilities.includes("voice"));
}

// One provider+model leg picker (realtime, or one of stt/llm/tts under
// CASCADE).
export function LegPicker({
  leg,
  label,
  credentials,
  providerId,
  model,
  onChange,
}: {
  leg: keyof typeof LEG_CAPABILITY;
  label: string;
  credentials: Credential[];
  providerId: string | null;
  model: string | null;
  onChange: (providerId: string | null, model: string | null) => void;
}) {
  const selectedCredential = credentials.find((c) => c.id === providerId);
  const models = modelsFor(selectedCredential, leg);

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-secondary">{label}</p>
      {credentials.length === 0 ? (
        <p className="text-xs text-tertiary">
          No provider credentials configured yet —{" "}
          <Link href="/admin/settings" className="text-cyan hover:underline">
            add one in Settings
          </Link>
          .
        </p>
      ) : (
        <div className="flex gap-2">
          <Select
            aria-label={`${label} provider`}
            value={providerId}
            onChange={(v) => onChange(v, null)}
            placeholder="Provider credential"
            options={credentials.map((c) => ({ value: c.id, label: `${c.label} (${c.provider})` }))}
            className="flex-1"
          />
          <Select
            aria-label={`${label} model`}
            value={model}
            onChange={(v) => onChange(providerId, v)}
            placeholder={models.length ? "Model" : "No models cached — refresh in Settings"}
            options={models.map((m) => ({ value: m.id, label: m.label ?? m.id }))}
            disabled={!providerId || models.length === 0}
            className="flex-1"
          />
        </div>
      )}
    </div>
  );
}

// Voice + speed picker for a TTS leg. Renders a real Select when the
// selected credential's provider returned a live voice list (ElevenLabs,
// Cartesia, OpenAI's static catalog — see voicesFor()); falls back to a
// free-text input for providers with no voice list at all (Sarvam,
// Deepgram, azure, ...) rather than blocking them from setting a voice id
// they already know.
export function VoicePicker({
  credential,
  voice,
  speed,
  onVoiceChange,
  onSpeedChange,
}: {
  credential: Credential | undefined;
  voice: string | null;
  speed: number | null;
  onVoiceChange: (voice: string | null) => void;
  onSpeedChange: (speed: number | null) => void;
}) {
  const voices = voicesFor(credential);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-secondary">
        Voice
        {voices.length > 0 ? (
          <Select
            aria-label="TTS voice"
            value={voice}
            onChange={(v) => onVoiceChange(v)}
            placeholder="Choose a voice"
            options={voices.map((v) => ({ value: v.id, label: v.label ?? v.id }))}
          />
        ) : (
          <input
            value={voice ?? ""}
            onChange={(e) => onVoiceChange(e.target.value || null)}
            placeholder="provider-specific voice id"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        )}
      </label>
      <label className="flex flex-col gap-1 text-xs text-secondary">
        Speed ({speed ?? 1.0}×, blank = provider default)
        <input
          type="range"
          min={0.5}
          max={2.0}
          step={0.05}
          value={speed ?? 1.0}
          onChange={(e) => onSpeedChange(Number(e.target.value))}
        />
      </label>
    </div>
  );
}
