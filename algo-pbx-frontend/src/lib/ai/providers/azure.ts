import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";

// Static locale/voice placeholders — Azure Speech's actual catalog is
// account/region-specific and large; this is a starter list covering the
// tenant's primary markets (India agents, UAE trunk).
const STATIC_MODELS: AiModelInfo[] = [
  { id: "en-IN", label: "English (India)", capabilities: ["stt", "tts"] },
  { id: "hi-IN", label: "Hindi (India)", capabilities: ["stt", "tts"] },
  { id: "ar-AE", label: "Arabic (UAE)", capabilities: ["stt", "tts"] },
];

export const azureAdapter: AiProviderAdapter = {
  provider: "azure",
  supportsLiveModelList: false,
  async listModels(): Promise<AiModelInfo[]> {
    return STATIC_MODELS;
  },
};
