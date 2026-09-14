import type { AiModelCapability, AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface DeepgramModelsResponse {
  // Deepgram's /v1/models response groups models by kind; we don't rely on
  // exact shape beyond "some list of objects with a name/id somewhere" —
  // be liberal in what we accept since this is a live third-party API.
  [key: string]: unknown;
}

interface DeepgramModelEntry {
  name?: string;
  model_id?: string;
  canonical_name?: string;
}

function flattenModelEntries(body: DeepgramModelsResponse): DeepgramModelEntry[] {
  const entries: DeepgramModelEntry[] = [];
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") entries.push(item as DeepgramModelEntry);
      }
    }
  }
  return entries;
}

export const deepgramAdapter: AiProviderAdapter = {
  provider: "deepgram",
  supportsLiveModelList: true,
  async listModels({ apiKey }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "deepgram");
    const body = (await fetchJson(
      "https://api.deepgram.com/v1/models",
      { headers: { Authorization: `Token ${key}` } },
      "deepgram"
    )) as DeepgramModelsResponse;
    const entries = flattenModelEntries(body);
    return entries.map((entry) => {
      const id = entry.model_id ?? entry.name ?? entry.canonical_name ?? "unknown";
      const name = entry.name ?? entry.canonical_name ?? id;
      const capabilities: AiModelCapability[] = ["stt"];
      if (name.toLowerCase().includes("aura")) capabilities.push("tts");
      return { id, label: name, capabilities };
    });
  },
};
