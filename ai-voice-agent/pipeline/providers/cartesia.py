"""Cartesia TTS (Sonic models). Requests raw mulaw/8000 output directly via
the `output_format` object in the request body, again avoiding resampling
before writing back to the AudioSocket.

ASSUMPTION: exact request schema (`model_id`, `transcript`, `voice.mode` /
`voice.id`, `output_format.{container,encoding,sample_rate}`) reconstructed
from Cartesia's public TTS API documentation from general knowledge, not
verified live.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator

import httpx

from ..base import ProviderLegConfig

DEFAULT_BASE_URL = "https://api.cartesia.ai"
API_VERSION = "2024-06-10"
CHUNK_SIZE = 4096


@dataclass
class CartesiaTts:
    config: ProviderLegConfig
    timeout_s: float = 20.0

    @property
    def base_url(self) -> str:
        return (self.config.base_url or DEFAULT_BASE_URL).rstrip("/")

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        url = f"{self.base_url}/tts/bytes"
        headers = {
            "X-API-Key": self.config.api_key,
            "Cartesia-Version": API_VERSION,
            "Content-Type": "application/json",
        }
        body = {
            "model_id": self.config.model or "sonic-english",
            "transcript": text,
            "voice": {"mode": "id", "id": self.config.voice or "default"},
            "output_format": {
                "container": "raw",
                "encoding": "pcm_mulaw",
                "sample_rate": 8000,
            },
        }
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(CHUNK_SIZE):
                    if chunk:
                        yield chunk
