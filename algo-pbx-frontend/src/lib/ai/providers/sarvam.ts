import type { AiModelInfo, AiProviderAdapter } from "@/lib/ai/types";

const STATIC_MODELS: AiModelInfo[] = [
  { id: "saarika:v2.5", label: "Saarika v2.5", capabilities: ["stt"] },
  { id: "saaras:v3", label: "Saaras v3", capabilities: ["stt"] },
  { id: "saaras:v3-realtime", label: "Saaras v3 (realtime)", capabilities: ["realtime"] },
  { id: "bulbul:v2", label: "Bulbul v2", capabilities: ["tts"] },
  { id: "bulbul:v3", label: "Bulbul v3", capabilities: ["tts"] },
  { id: "sarvam-m", label: "Sarvam-M", capabilities: ["llm"] },
];

export const sarvamAdapter: AiProviderAdapter = {
  provider: "sarvam",
  supportsLiveModelList: false,
  async listModels(): Promise<AiModelInfo[]> {
    return STATIC_MODELS;
  },
};
