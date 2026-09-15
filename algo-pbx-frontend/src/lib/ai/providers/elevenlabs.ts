import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

// GET /v1/models returns a bare array, not an envelope.
interface ElevenLabsModelEntry {
  model_id: string;
  name?: string;
}
interface ElevenLabsVoicesResponse {
  voices?: Array<{ voice_id: string; name?: string }>;
}

export const elevenlabsAdapter: AiProviderAdapter = {
  provider: "elevenlabs",
  supportsLiveModelList: true,
  async listModels({ apiKey }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "elevenlabs");
    const headers = { "xi-api-key": key };

    const modelsBody = (await fetchJson(
      "https://api.elevenlabs.io/v1/models",
      { headers },
      "elevenlabs"
    )) as ElevenLabsModelEntry[] | unknown;
    const models: ElevenLabsModelEntry[] = Array.isArray(modelsBody) ? modelsBody : [];
    const modelEntries: AiModelInfo[] = models.map((model) => ({
      id: model.model_id,
      label: model.name,
      capabilities: ["tts"],
    }));

    const voicesBody = (await fetchJson(
      "https://api.elevenlabs.io/v2/voices",
      { headers },
      "elevenlabs"
    )) as ElevenLabsVoicesResponse;
    // Fixed 2026-09-15 (workflow-builder plan, blocker #7): this used to be
    // tagged "tts" — the same capability as the model entries above — which
    // meant the admin editor's TTS *model* dropdown showed ~100 voice IDs
    // mixed in with the 3 real models (modelsFor() filters purely on
    // capability). Voices are a distinct thing from models; tag them
    // distinctly so the UI can render them in their own picker.
    const voiceEntries: AiModelInfo[] = (voicesBody.voices ?? []).map((voice) => ({
      id: voice.voice_id,
      label: voice.name,
      capabilities: ["voice"],
    }));

    return [...modelEntries, ...voiceEntries];
  },
};
