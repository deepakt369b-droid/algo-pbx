import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";

const STATIC_MODELS: AiModelInfo[] = [
  { id: "universal-streaming", label: "Universal Streaming", capabilities: ["stt"] },
];

export const assemblyaiAdapter: AiProviderAdapter = {
  provider: "assemblyai",
  supportsLiveModelList: false,
  async listModels(): Promise<AiModelInfo[]> {
    return STATIC_MODELS;
  },
};
