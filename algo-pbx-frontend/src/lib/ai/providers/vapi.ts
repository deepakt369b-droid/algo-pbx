import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";

const STATIC_MODELS: AiModelInfo[] = [
  { id: "vapi-default", label: "Vapi agent — platform provider, SIP routed", capabilities: ["realtime"] },
];

export const vapiAdapter: AiProviderAdapter = {
  provider: "vapi",
  supportsLiveModelList: false,
  async listModels(): Promise<AiModelInfo[]> {
    return STATIC_MODELS;
  },
};
