// Language catalog for AI agent configuration. Replaces the previous
// hardcoded 4-item LANGUAGE_OPTIONS in the agent editor (en/hi/hi-en/ar) —
// the wider list here is what an agent's `language` field (the BCP-47-ish
// tag surfaced to the caller/UI) can be set to. `sttTag`/`ttsTag` exist
// because providers don't agree on tag format for the same language (Sarvam
// wants "hi-IN", Deepgram wants "hi") — this module is the single place
// that mapping lives, so agent-config/route.ts can emit an
// already-provider-correct tag and no mapping logic has to live in the
// Python sidecar (see AiAgent.sttLanguage's schema comment).

export interface AiLanguage {
  tag: string; // the value stored on AiAgent.language / VariableSpec context
  label: string;
  sttTag?: string; // defaults to `tag` when omitted
  ttsTag?: string; // defaults to `tag` when omitted
}

export const AI_LANGUAGES: AiLanguage[] = [
  { tag: "en", label: "English" },
  { tag: "en-IN", label: "English (India)" },
  { tag: "en-GB", label: "English (UK)" },
  { tag: "en-US", label: "English (US)" },
  { tag: "hi", label: "Hindi", sttTag: "hi", ttsTag: "hi-IN" },
  { tag: "hi-en", label: "Hindi/English (code-mix)", sttTag: "hi", ttsTag: "hi-IN" },
  { tag: "ar", label: "Arabic", ttsTag: "ar-XA" },
  { tag: "ar-AE", label: "Arabic (UAE)", ttsTag: "ar-XA" },
  { tag: "ar-SA", label: "Arabic (Saudi Arabia)", ttsTag: "ar-XA" },
  { tag: "ur", label: "Urdu" },
  { tag: "bn", label: "Bengali", ttsTag: "bn-IN" },
  { tag: "ta", label: "Tamil", ttsTag: "ta-IN" },
  { tag: "te", label: "Telugu", ttsTag: "te-IN" },
  { tag: "mr", label: "Marathi", ttsTag: "mr-IN" },
  { tag: "gu", label: "Gujarati", ttsTag: "gu-IN" },
  { tag: "kn", label: "Kannada", ttsTag: "kn-IN" },
  { tag: "ml", label: "Malayalam", ttsTag: "ml-IN" },
  { tag: "pa", label: "Punjabi", ttsTag: "pa-IN" },
  { tag: "es", label: "Spanish" },
  { tag: "es-MX", label: "Spanish (Mexico)" },
  { tag: "fr", label: "French" },
  { tag: "de", label: "German" },
  { tag: "pt", label: "Portuguese" },
  { tag: "pt-BR", label: "Portuguese (Brazil)" },
  { tag: "it", label: "Italian" },
  { tag: "nl", label: "Dutch" },
  { tag: "ru", label: "Russian" },
  { tag: "tr", label: "Turkish" },
  { tag: "id", label: "Indonesian" },
  { tag: "vi", label: "Vietnamese" },
  { tag: "th", label: "Thai" },
  { tag: "zh", label: "Chinese (Mandarin)" },
  { tag: "ja", label: "Japanese" },
  { tag: "ko", label: "Korean" },
];

export function languageLabel(tag: string): string {
  return AI_LANGUAGES.find((l) => l.tag === tag)?.label ?? tag;
}

/** Resolves a provider-facing tag for STT/TTS from the agent's own
 * `language` field. Falls back to `tag` itself for any language not in the
 * catalog (a hand-typed/legacy value) rather than throwing — this module
 * must never be the reason a call fails to start. */
export function sttLanguageTag(tag: string): string {
  return AI_LANGUAGES.find((l) => l.tag === tag)?.sttTag ?? tag;
}

export function ttsLanguageTag(tag: string): string {
  return AI_LANGUAGES.find((l) => l.tag === tag)?.ttsTag ?? tag;
}
