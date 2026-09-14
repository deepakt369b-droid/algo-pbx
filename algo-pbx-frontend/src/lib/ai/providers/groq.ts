import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";
import { fetchJson, requireApiKey } from "./_fetch";

interface GroqModelsResponse {
  data?: Array<{ id: string }>;
}

export const groqAdapter: AiProviderAdapter = {
  provider: "groq",
  supportsLiveModelList: true,
  async listModels({ apiKey }): Promise<AiModelInfo[]> {
    const key = requireApiKey(apiKey, "groq");
    const body = (await fetchJson(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: `Bearer ${key}` } },
      "groq"
    )) as GroqModelsResponse;
    const models = body.data ?? [];
    return models.map((model) => ({ id: model.id, capabilities: ["llm"] }));
  },
};
