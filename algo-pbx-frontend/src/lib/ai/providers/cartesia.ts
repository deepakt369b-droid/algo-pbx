import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface CartesiaVoiceEntry {
  id: string;
  name?: string;
}

const CARTESIA_VERSION = "2024-06-10";

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
    return voices.map((voice) => ({ id: voice.id, label: voice.name, capabilities: ["tts"] }));
  },
};
