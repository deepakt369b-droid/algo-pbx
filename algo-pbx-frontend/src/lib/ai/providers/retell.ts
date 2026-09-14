import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";

const STATIC_MODELS: AiModelInfo[] = [
  { id: "retell-default", label: "Retell agent — platform provider, SIP routed", capabilities: ["realtime"] },
];

export const retellAdapter: AiProviderAdapter = {
  provider: "retell",
  supportsLiveModelList: false,
  async listModels(): Promise<AiModelInfo[]> {
    return STATIC_MODELS;
  },
};
