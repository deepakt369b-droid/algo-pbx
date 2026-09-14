import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface AnthropicModelsResponse {
  data?: Array<{ id: string; display_name?: string }>;
}

export const anthropicAdapter: AiProviderAdapter = {
  provider: "anthropic",
  supportsLiveModelList: true,
  async listModels({ apiKey }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "anthropic");
    const body = (await fetchJson(
      "https://api.anthropic.com/v1/models",
      { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } },
      "anthropic"
    )) as AnthropicModelsResponse;
    const models = body.data ?? [];
    return models.map((model) => ({
      id: model.id,
      label: model.display_name,
      capabilities: ["llm"],
    }));
  },
};
