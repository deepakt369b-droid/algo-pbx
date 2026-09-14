import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { assertPublicHttpUrl, fetchJson, requireApiKey } from "./_fetch";

// Generic OpenAI-compatible adapter. Covers OpenRouter, Together, Azure
// OpenAI, and Sarvam-M per the contract — the caller must wire the right
// `baseUrl` (e.g. an Azure resource endpoint) for each of those; this
// adapter itself is vendor-agnostic.
interface OpenAiCompatibleModelsResponse {
  data?: Array<{ id: string }>;
}

export const openaiCompatibleAdapter: AiProviderAdapter = {
  provider: "openai_compatible",
  supportsLiveModelList: true,
  async listModels({ apiKey, baseUrl }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "openai_compatible");
    if (!baseUrl) {
      throw new Error("openai_compatible: baseUrl is required (e.g. OpenRouter/Together/Azure OpenAI endpoint)");
    }
    assertPublicHttpUrl(baseUrl, "openai_compatible");
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const body = (await fetchJson(
      url,
      { headers: { Authorization: `Bearer ${key}` } },
      "openai_compatible"
    )) as OpenAiCompatibleModelsResponse;
    const models = body.data ?? [];
    return models.map((model) => ({ id: model.id, capabilities: ["llm"] }));
  },
};
