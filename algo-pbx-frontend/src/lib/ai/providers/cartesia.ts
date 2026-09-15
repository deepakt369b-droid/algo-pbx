import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface CartesiaVoiceEntry {
  id: string;
  name?: string;
}

const CARTESIA_VERSION = "2024-06-10";

// Cartesia has no public list-models endpoint this adapter calls — only
// /voices. Fixed 2026-09-15 (workflow-builder plan, blocker #7): before
// this, the ONLY entries this adapter ever returned were voices tagged
// "tts", so the TTS *model* dropdown showed voice IDs as if they were
// models and there was no way to pick a real model at all. A static
// catalog fills that gap; sidecar/pipeline/providers/cartesia.py already
// assumes "sonic-english" as its own hardcoded default, so that id is kept
// consistent here rather than invented fresh.
const CARTESIA_STATIC_MODELS: AiModelInfo[] = [
  { id: "sonic-2", label: "Sonic 2", capabilities: ["tts"] },
  { id: "sonic-english", label: "Sonic (English)", capabilities: ["tts"] },
  { id: "sonic-multilingual", label: "Sonic (Multilingual)", capabilities: ["tts"] },
];

export const cartesiaAdapter: AiProviderAdapter = {
  provider: "cartesia",
  supportsLiveModelList: true,
  async listModels({ apiKey }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "cartesia");
    const body = (await fetchJson(
      "https://api.cartesia.ai/voices",
      { headers: { "X-API-Key": key, "Cartesia-Version": CARTESIA_VERSION } },
      "cartesia"
    )) as CartesiaVoiceEntry[] | { data?: CartesiaVoiceEntry[] };
    const voices: CartesiaVoiceEntry[] = Array.isArray(body) ? body : body.data ?? [];
    const voiceEntries: AiModelInfo[] = voices.map((voice) => ({
      id: voice.id,
      label: voice.name,
      capabilities: ["voice"],
    }));
    return [...CARTESIA_STATIC_MODELS, ...voiceEntries];
  },
};
