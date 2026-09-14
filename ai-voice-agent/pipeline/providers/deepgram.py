"""STT via Deepgram's streaming websocket API.

Deepgram's `listen` websocket accepts raw mulaw/8000 audio directly (via
`encoding=mulaw&sample_rate=8000` query params), which matches Asterisk's
AudioSocket ulaw framing option with no resampling needed - this is the
provider's headline advantage over, e.g., Gemini which requires PCM16/16kHz.
If the AudioSocket leg is running slin (the default assumed in
audiosocket/protocol.py) instead of ulaw, `encoding` should be switched to
`linear16` - see `encoding` field below.

ASSUMPTION: exact Deepgram message schema (`Results` events with
`channel.alternatives[0].transcript` and `is_final`) is reconstructed from
public Deepgram API documentation knowledge, not verified against a live
endpoint.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator
from urllib.parse import urlencode

import websockets

from ..base import ProviderLegConfig

DEFAULT_WS_URL = "wss://api.deepgram.com/v1/listen"


@dataclass
class DeepgramStt:
    config: ProviderLegConfig
    encoding: str = "mulaw"  # or "linear16" if the AudioSocket leg is slin
    sample_rate: int = 8000

    def _url(self) -> str:
        base = self.config.base_url or DEFAULT_WS_URL
        params = {
            "model": self.config.model or "nova-2",
            "encoding": self.encoding,
            "sample_rate": self.sample_rate,
            "channels": 1,
            "punctuate": "true",
            "interim_results": "true",
            "language": self.config.extra.get("language", "en") if self.config.extra else "en",
        }
        return f"{base}?{urlencode(params)}"

    async def transcribe_stream(self, audio_chunks: AsyncIterator[bytes]) -> str:
        headers = {"Authorization": f"Token {self.config.api_key}"}
        final_parts: list[str] = []
        async with websockets.connect(self._url(), additional_headers=headers) as ws:

            async def sender() -> None:
                async for chunk in audio_chunks:
                    await ws.send(chunk)
                # Deepgram convention: send an empty binary frame /
                # CloseStream message to flag end-of-audio.
                await ws.send(b"")

            import asyncio
            import json

            send_task = asyncio.create_task(sender())
            try:
                async for message in ws:
                    if isinstance(message, (bytes, bytearray)):
                        continue
                    event = json.loads(message)
                    if event.get("type") != "Results":
                        continue
                    alt = event.get("channel", {}).get("alternatives", [{}])[0]
                    transcript = alt.get("transcript", "")
                    if transcript and event.get("is_final"):
                        final_parts.append(transcript)
                    if event.get("speech_final"):
                        break
            finally:
                send_task.cancel()

        return " ".join(final_parts).strip()
