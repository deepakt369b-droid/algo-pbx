import type { AiProviderAdapter, AiProviderKind } from "@/lib/ai/types";
import { openaiAdapter } from "./openai";
import { anthropicAdapter } from "./anthropic";
import { geminiAdapter } from "./gemini";
import { groqAdapter } from "./groq";
import { deepgramAdapter } from "./deepgram";
import { elevenlabsAdapter } from "./elevenlabs";
import { cartesiaAdapter } from "./cartesia";
import { sarvamAdapter } from "./sarvam";
import { assemblyaiAdapter } from "./assemblyai";
import { azureAdapter } from "./azure";
import { ultravoxAdapter } from "./ultravox";
import { openaiCompatibleAdapter } from "./openai-compatible";
import { retellAdapter } from "./retell";
import { vapiAdapter } from "./vapi";

export const providerAdapters: Record<AiProviderKind, AiProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  groq: groqAdapter,
  deepgram: deepgramAdapter,
  elevenlabs: elevenlabsAdapter,
  cartesia: cartesiaAdapter,
  sarvam: sarvamAdapter,
  assemblyai: assemblyaiAdapter,
  azure: azureAdapter,
  ultravox: ultravoxAdapter,
  openai_compatible: openaiCompatibleAdapter,
  retell: retellAdapter,
  vapi: vapiAdapter,
};

export function getProviderAdapter(kind: AiProviderKind): AiProviderAdapter {
  const adapter = providerAdapters[kind];
  if (!adapter) {
    throw new Error(`No AI provider adapter registered for "${kind}"`);
  }
  return adapter;
}

export type { AiProviderAdapter, AiProviderKind } from "@/lib/ai/types";
