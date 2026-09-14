"""Sarvam AI: `saaras` STT and `bulbul` TTS, for Hindi/Hinglish support.

ASSUMPTION: exact REST endpoints/field names are reconstructed from Sarvam's
publicly documented Speech-to-Text (`saaras`) and Text-to-Speech (`bulbul`)
APIs from general knowledge, not verified live. Both are plain HTTPS request/
response (not streaming websockets), so `transcribe_stream` buffers the full
utterance before calling out - acceptable since the cascade pipeline already
buffers one caller turn at a time (VAD-delimited) before invoking STT.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator

import httpx

from ..base import ProviderLegConfig

DEFAULT_BASE_URL = "https://api.sarvam.ai"


@dataclass
class SarvamStt:
    config: ProviderLegConfig
    timeout_s: float = 15.0

    @property
    def base_url(self) -> str:
        return (self.config.base_url or DEFAULT_BASE_URL).rstrip("/")

    async def transcribe_stream(self, audio_chunks: AsyncIterator[bytes]) -> str:
        buf = bytearray()
        async for chunk in audio_chunks:
            buf.extend(chunk)

        headers = {"api-subscription-key": self.config.api_key}
        files = {"file": ("audio.wav", _pcm_to_wav_bytes(bytes(buf)), "audio/wav")}
        data = {"model": self.config.model or "saaras:v2"}
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            resp = await client.post(
                f"{self.base_url}/speech-to-text",
                headers=headers,
                data=data,
                files=files,
            )
            resp.raise_for_status()
            body = resp.json()
            return body.get("transcript", "")


@dataclass
class SarvamTts:
    config: ProviderLegConfig
    timeout_s: float = 15.0

    @property
    def base_url(self) -> str:
        return (self.config.base_url or DEFAULT_BASE_URL).rstrip("/")

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        headers = {
            "api-subscription-key": self.config.api_key,
            "Content-Type": "application/json",
        }
        body = {
            "text": text,
            "target_language_code": self.config.extra.get("language", "hi-IN") if self.config.extra else "hi-IN",
            "speaker": self.config.voice or "meera",
            "model": self.config.model or "bulbul:v2",
            "speech_sample_rate": 8000,
        }
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            resp = await client.post(f"{self.base_url}/text-to-speech", headers=headers, json=body)
            resp.raise_for_status()
            payload = resp.json()
            for b64_audio in payload.get("audios", []):
                import base64

                yield base64.b64decode(b64_audio)


def _pcm_to_wav_bytes(pcm: bytes, sample_rate: int = 8000) -> bytes:
    """Wrap raw slin16 PCM in a minimal WAV header - Sarvam's STT endpoint
    expects a file upload, not a raw stream."""
    import struct as _struct

    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm)
    header = b"RIFF" + _struct.pack("<I", 36 + data_size) + b"WAVE"
    header += b"fmt " + _struct.pack("<IHHIIHH", 16, 1, num_channels, sample_rate, byte_rate, block_align, bits_per_sample)
    header += b"data" + _struct.pack("<I", data_size)
    return header + pcm
