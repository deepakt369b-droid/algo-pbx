import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface UltravoxVoiceEntry {
  voiceId?: string;
  id?: string;
  name?: string;
}

export const ultravoxAdapter: AiProviderAdapter = {
  provider: "ultravox",
  supportsLiveModelList: true,
  async listModels({ apiKey }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "ultravox");
    const body = (await fetchJson(
      "https://api.ultravox.ai/api/voices",
      { headers: { "X-API-Key": key } },
      "ultravox"
    )) as UltravoxVoiceEntry[] | { results?: UltravoxVoiceEntry[] };
    const voices: UltravoxVoiceEntry[] = Array.isArray(body) ? body : body.results ?? [];
    return voices.map((voice) => ({
      id: voice.voiceId ?? voice.id ?? "unknown",
      label: voice.name,
      capabilities: ["tts"],
    }));
  },
};
