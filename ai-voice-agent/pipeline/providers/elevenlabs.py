"""ElevenLabs TTS. Requests `ulaw_8000` output format directly when
supported (`output_format=ulaw_8000` query param on the v1 TTS endpoint),
avoiding any resampling before sending audio back down the AudioSocket -
matching the same "ask the vendor for 8kHz telephony audio directly" pattern
used by the Deepgram STT and OpenAI Realtime providers in this package.

ASSUMPTION: exact endpoint path/params reconstructed from ElevenLabs' public
TTS API documentation from general knowledge, not verified live.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator

import httpx

from ..base import ProviderLegConfig

DEFAULT_BASE_URL = "https://api.elevenlabs.io"
CHUNK_SIZE = 4096


@dataclass
class ElevenLabsTts:
    config: ProviderLegConfig
    timeout_s: float = 20.0
    output_format: str = "ulaw_8000"

    @property
    def base_url(self) -> str:
        return (self.config.base_url or DEFAULT_BASE_URL).rstrip("/")

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        voice_id = self.config.voice or "21m00Tcm4TlvDq8ikWAM"
        url = f"{self.base_url}/v1/text-to-speech/{voice_id}/stream"
        headers = {
            "xi-api-key": self.config.api_key,
            "Content-Type": "application/json",
            "Accept": "audio/*",
        }
        body = {
            "text": text,
            "model_id": self.config.model or "eleven_turbo_v2_5",
            "output_format": self.output_format,
        }
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(CHUNK_SIZE):
                    if chunk:
                        yield chunk
