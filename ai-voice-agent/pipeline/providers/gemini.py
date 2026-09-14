"""Gemini: `generateContent` for plain LLM use, plus a realtime
speech-to-speech client for Gemini Live (`BidiGenerateContent` websocket).

IMPORTANT sample-rate note: Gemini Live expects PCM16 audio IN at 16kHz and
returns PCM16 audio OUT at 24kHz. Asterisk/AudioSocket gives us (and expects
back) 8kHz slin. This module therefore resamples 8kHz -> 16kHz before sending
to Gemini, and 24kHz -> 8kHz on the way back, using `audioop.ratecv` (stdlib,
available on Python 3.10-3.12; removed in 3.13 - see `_ratecv` fallback).
This resampling is the one genuinely provider-specific wrinkle among the
realtime providers in this package; contrast with `openai_realtime.py`, which
needs none because OpenAI Realtime accepts/returns g711_ulaw at 8kHz
natively.

ASSUMPTION: exact BidiGenerateContent message envelope (`setup`,
`clientContent`/`realtimeInput`, `serverContent.modelTurn.parts[].inlineData`)
reconstructed from public Gemini Live API documentation from general
knowledge, not verified live.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable

import httpx
import websockets

from ..base import ChatMessage, LlmDelta, OutgoingAudioSink, ProviderLegConfig, ToolCall, ToolSpec

DEFAULT_GENERATE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_LIVE_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

IN_RATE = 8000
GEMINI_IN_RATE = 16000
GEMINI_OUT_RATE = 24000


def _ratecv(pcm16: bytes, in_rate: int, out_rate: int, state=None) -> tuple[bytes, Any]:
    """Resample signed 16-bit mono PCM using stdlib `audioop` when available.
    Falls back to naive linear-interpolation resampling (no external deps)
    on Python 3.13+, where `audioop` was removed - adequate for voice-band
    telephony audio though not as clean as a proper polyphase resampler.
    """
    try:
        import audioop  # type: ignore

        return audioop.ratecv(pcm16, 2, 1, in_rate, out_rate, state)
    except ImportError:
        return _naive_resample(pcm16, in_rate, out_rate), None


def _naive_resample(pcm16: bytes, in_rate: int, out_rate: int) -> bytes:
    import struct

    if in_rate == out_rate or not pcm16:
        return pcm16
    samples = struct.unpack(f"<{len(pcm16) // 2}h", pcm16)
    ratio = out_rate / in_rate
    out_len = max(1, int(len(samples) * ratio))
    out_samples = []
    for i in range(out_len):
        src_pos = i / ratio
        lo = int(src_pos)
        hi = min(lo + 1, len(samples) - 1)
        frac = src_pos - lo
        val = samples[lo] * (1 - frac) + samples[hi] * frac
        out_samples.append(int(val))
    return struct.pack(f"<{len(out_samples)}h", *out_samples)


@dataclass
class GeminiLlm:
    config: ProviderLegConfig
    timeout_s: float = 30.0

    @property
    def base_url(self) -> str:
        return (self.config.base_url or DEFAULT_GENERATE_BASE_URL).rstrip("/")

    async def generate(
        self, messages: list[ChatMessage], tools: list[ToolSpec] | None = None
    ) -> AsyncIterator[LlmDelta]:
        """Non-streaming generateContent call wrapped as a single-chunk
        async generator, to satisfy the shared LlmProvider Protocol. Gemini
        supports `streamGenerateContent` too; kept simple here since the
        cascade pipeline tolerates a single flush per turn."""
        url = f"{self.base_url}/models/{self.config.model}:generateContent?key={self.config.api_key}"
        system_parts = [m.content for m in messages if m.role == "system"]
        contents = [
            {"role": "user" if m.role == "user" else "model", "parts": [{"text": m.content}]}
            for m in messages
            if m.role != "system"
        ]
        body: dict = {"contents": contents}
        if system_parts:
            body["systemInstruction"] = {"parts": [{"text": "\n".join(system_parts)}]}
        if tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {"name": t.name, "description": t.description, "parameters": t.parameters}
                        for t in tools
                    ]
                }
            ]

        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            data = resp.json()
            parts = data["candidates"][0]["content"]["parts"]
            for part in parts:
                if "functionCall" in part:
                    fc = part["functionCall"]
                    yield LlmDelta(tool_call=ToolCall(name=fc["name"], arguments=fc.get("args", {})))
                elif "text" in part:
                    yield LlmDelta(text=part["text"])


@dataclass
class GeminiRealtime:
    """Speech-to-speech via Gemini Live's BidiGenerateContent websocket."""

    config: ProviderLegConfig
    timeout_s: float = 30.0

    @property
    def ws_url(self) -> str:
        base = self.config.base_url or DEFAULT_LIVE_WS_URL
        return f"{base}?key={self.config.api_key}"

    async def run(
        self,
        audio_in: AsyncIterator[bytes],
        audio_out: OutgoingAudioSink,
        *,
        tools: list[ToolSpec] | None = None,
        on_tool_call: "Callable[[ToolCall], Awaitable[None]] | None" = None,
    ) -> None:
        setup: dict = {
            "model": f"models/{self.config.model}",
            "generationConfig": {"responseModalities": ["AUDIO"]},
        }
        if tools:
            setup["tools"] = [
                {
                    "functionDeclarations": [
                        {"name": t.name, "description": t.description, "parameters": t.parameters}
                        for t in tools
                    ]
                }
            ]
        async with websockets.connect(self.ws_url, max_size=None) as ws:
            await ws.send(json.dumps({"setup": setup}))

            import asyncio

            async def sender() -> None:
                enc_state = None
                async for chunk in audio_in:
                    pcm16k, enc_state = _ratecv(chunk, IN_RATE, GEMINI_IN_RATE, enc_state)
                    await ws.send(
                        json.dumps(
                            {
                                "realtimeInput": {
                                    "mediaChunks": [
                                        {"mimeType": "audio/pcm;rate=16000", "data": base64.b64encode(pcm16k).decode()}
                                    ]
                                }
                            }
                        )
                    )

            send_task = asyncio.create_task(sender())
            dec_state = None
            try:
                async for raw in ws:
                    if isinstance(raw, (bytes, bytearray)):
                        continue
                    event = json.loads(raw)
                    parts = (
                        event.get("serverContent", {})
                        .get("modelTurn", {})
                        .get("parts", [])
                    )
                    for part in parts:
                        inline = part.get("inlineData")
                        if not inline:
                            continue
                        pcm24k = base64.b64decode(inline["data"])
                        pcm8k, dec_state = _ratecv(pcm24k, GEMINI_OUT_RATE, IN_RATE, dec_state)
                        audio_out.push(pcm8k)
                    tool_call_msg = event.get("toolCall")
                    if tool_call_msg and on_tool_call is not None:
                        for fc in tool_call_msg.get("functionCalls", []):
                            await on_tool_call(
                                ToolCall(name=fc["name"], arguments=fc.get("args", {}), call_id=fc.get("id"))
                            )
                    if event.get("serverContent", {}).get("turnComplete"):
                        continue
            finally:
                send_task.cancel()
