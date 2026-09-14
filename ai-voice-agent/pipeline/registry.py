"""Picks provider classes by the `provider` string in AiAgentConfigResponse's
legs (the `AiProviderKind` union in types.ts). Kept as simple dict lookups
rather than a plugin system - the provider set is small and fixed per the
frozen contract.
"""

from __future__ import annotations

from .base import ProviderLegConfig
from .providers.cartesia import CartesiaTts
from .providers.deepgram import DeepgramStt
from .providers.elevenlabs import ElevenLabsTts
from .providers.gemini import GeminiLlm, GeminiRealtime
from .providers.openai_compatible import OpenAiCompatibleLlm
from .providers.openai_realtime import OpenAiRealtime
from .providers.sarvam import SarvamStt, SarvamTts


class UnknownProviderError(Exception):
    pass


# LLM: providers that speak the OpenAI-compatible /chat/completions wire
# format reuse the same adapter class - openai/groq/openai_compatible cover
# OpenAI, Groq, OpenRouter, Together, Sarvam-M, Azure OpenAI per the
# contract's generic-adapter note.
_LLM_OPENAI_COMPATIBLE = {"openai", "groq", "openai_compatible", "azure"}

_STT_REGISTRY = {
    "deepgram": DeepgramStt,
    "sarvam": SarvamStt,
}

_TTS_REGISTRY = {
    "elevenlabs": ElevenLabsTts,
    "cartesia": CartesiaTts,
    "sarvam": SarvamTts,
}

_REALTIME_REGISTRY = {
    "openai": OpenAiRealtime,
    "gemini": GeminiRealtime,
}


def build_llm(config: ProviderLegConfig):
    if config.provider in _LLM_OPENAI_COMPATIBLE:
        return OpenAiCompatibleLlm(config=config)
    if config.provider == "gemini":
        return GeminiLlm(config=config)
    raise UnknownProviderError(f"no LLM provider registered for '{config.provider}'")


def build_stt(config: ProviderLegConfig):
    cls = _STT_REGISTRY.get(config.provider)
    if cls is None:
        raise UnknownProviderError(f"no STT provider registered for '{config.provider}'")
    return cls(config=config)


def build_tts(config: ProviderLegConfig):
    cls = _TTS_REGISTRY.get(config.provider)
    if cls is None:
        raise UnknownProviderError(f"no TTS provider registered for '{config.provider}'")
    return cls(config=config)


def build_realtime(config: ProviderLegConfig, *, system_prompt: str = ""):
    if config.provider == "openai":
        return OpenAiRealtime(config=config, system_prompt=system_prompt)
    if config.provider == "gemini":
        return GeminiRealtime(config=config)
    raise UnknownProviderError(f"no realtime provider registered for '{config.provider}'")
