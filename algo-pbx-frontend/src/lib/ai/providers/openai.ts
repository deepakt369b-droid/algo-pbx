import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface OpenAiModelsResponse {
  data?: Array<{ id: string }>;
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
    return models.map((model) => ({
      id: model.id,
      capabilities: [model.id.includes("realtime") ? "realtime" : "llm"],
    }));
  },
};
