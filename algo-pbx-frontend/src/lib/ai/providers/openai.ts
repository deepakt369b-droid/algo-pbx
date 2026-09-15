import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface OpenAiModelsResponse {
  data?: Array<{ id: string }>;
}

// OpenAI's voices are a fixed, undocumented-via-API set — there is no
// list-voices endpoint, so this is a static catalog, same shape as Sarvam's
// STATIC_MODELS. Added 2026-09-15 (workflow-builder plan) alongside a fix
// to model-capability classification below: `/v1/models` returns every
// OpenAI model type mixed together (chat, tts-1/tts-1-hd, whisper,
// embeddings, ...), and before this fix everything non-realtime was
// mislabeled "llm" — including TTS and transcription models, the same
// class of bug fixed for ElevenLabs/Cartesia's voice/model conflation.
const OPENAI_VOICES: AiModelInfo[] = [
  { id: "alloy", label: "Alloy", capabilities: ["voice"] },
  { id: "echo", label: "Echo", capabilities: ["voice"] },
  { id: "fable", label: "Fable", capabilities: ["voice"] },
  { id: "onyx", label: "Onyx", capabilities: ["voice"] },
  { id: "nova", label: "Nova", capabilities: ["voice"] },
  { id: "shimmer", label: "Shimmer", capabilities: ["voice"] },
];

function classifyOpenAiModel(id: string): AiModelInfo["capabilities"] {
  if (id.includes("realtime")) return ["realtime"];
  if (id.startsWith("tts-")) return ["tts"];
  if (id.startsWith("whisper")) return ["stt"];
  if (id.includes("embedding")) return [];
  return ["llm"];
}

export const openaiAdapter: AiProviderAdapter = {
  provider: "openai",
  supportsLiveModelList: true,
  async listModels({ apiKey }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "openai");
    const body = (await fetchJson(
      "https://api.openai.com/v1/models",
      { headers: { Authorization: `Bearer ${key}` } },
      "openai"
    )) as OpenAiModelsResponse;
    const models = body.data ?? [];
    const modelEntries: AiModelInfo[] = models
      .map((model) => ({ id: model.id, capabilities: classifyOpenAiModel(model.id) }))
      .filter((entry) => entry.capabilities.length > 0);
    return [...modelEntries, ...OPENAI_VOICES];
  },
};
