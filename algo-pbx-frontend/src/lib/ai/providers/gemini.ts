import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface GeminiModelsResponse {
  models?: Array<{
    name: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
}

export const geminiAdapter: AiProviderAdapter = {
  provider: "gemini",
  supportsLiveModelList: true,
  async listModels({ apiKey }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "gemini");
    const body = (await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      {},
      "gemini"
    )) as GeminiModelsResponse;
    const models = body.models ?? [];
    return models
      .filter(
        (model) =>
          (model.supportedGenerationMethods ?? []).includes("bidiGenerateContent") ||
          (model.supportedGenerationMethods ?? []).includes("generateContent")
      )
      .map((model) => ({
        id: model.name,
        label: model.displayName,
        capabilities: [
          (model.supportedGenerationMethods ?? []).includes("bidiGenerateContent") ? "realtime" : "llm",
        ],
      }));
  },
};
