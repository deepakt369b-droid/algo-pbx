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
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

import httpx
import websockets

from ..base import ChatMessage, LlmDelta, OutgoingAudioSink, ProviderLegConfig, ToolCall, ToolSpec

logger = logging.getLogger(__name__)

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


def _content_part(m: ChatMessage) -> dict:
    """Map one ChatMessage to Gemini's `contents[]` shape. An
    assistant-with-tool_calls becomes a `model` turn whose parts are
    `functionCall`s (no text part alongside, matching how Gemini itself
    emits them); a `role="tool"` message becomes a `user`-turn
    `functionResponse` part - Gemini has no separate "tool" role, function
    responses are sent back as part of the next user-role turn."""
    if m.role == "assistant" and m.tool_calls:
        return {
            "role": "model",
            "parts": [{"functionCall": {"name": tc.name, "args": tc.arguments}} for tc in m.tool_calls],
        }
    if m.role == "tool":
        return {
            "role": "user",
            "parts": [{"functionResponse": {"name": m.name or "", "response": _as_response_dict(m.content)}}],
        }
    return {"role": "user" if m.role == "user" else "model", "parts": [{"text": m.content}]}


def _as_response_dict(content: str) -> dict:
    """Gemini's functionResponse.response must be a JSON object, not a raw
    string - the tool-result content this pipeline stores is a JSON-encoded
    string (see runner.py's tool-result serialization), so decode it back;
    fall back to wrapping non-JSON content rather than raising mid-call."""
    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else {"result": parsed}
    except json.JSONDecodeError:
        return {"result": content}


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
        contents = [_content_part(m) for m in messages if m.role != "system"]
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
        generation_config: dict = {}
        temperature = self.config.extra.get("temperature")
        if temperature is not None:
            generation_config["temperature"] = temperature
        max_tokens = self.config.extra.get("max_tokens")
        if max_tokens is not None:
            generation_config["maxOutputTokens"] = max_tokens
        if generation_config:
            body["generationConfig"] = generation_config

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
    """Speech-to-speech via Gemini Live's BidiGenerateContent websocket.

    KNOWN LIMITATION, by design: `setup` is send-once-at-connection - Gemini
    Live has no message that swaps `systemInstruction`/`tools` on an already
    running session (contrast with OpenAI Realtime's `session.update`, which
    is genuinely idempotent mid-session). `update_session()` on this class is
    therefore a documented no-op: a workflow node transition cannot move a
    Gemini Live call to a new node's instructions without dropping the
    connection and losing conversational state. The workflow publish-time
    validator (`workflow-schema.ts`) rejects WORKFLOW mode + Gemini realtime
    for exactly this reason - this method should never actually be invoked
    against this class in production; it logs loudly if it is."""

    config: ProviderLegConfig
    system_prompt: str = ""
    timeout_s: float = 30.0
    _ws: "websockets.WebSocketClientProtocol | None" = field(default=None, init=False, repr=False)

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
        if self.system_prompt:
            setup["systemInstruction"] = {"parts": [{"text": self.system_prompt}]}
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
            self._ws = ws
            try:
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
                                            {
                                                "mimeType": "audio/pcm;rate=16000",
                                                "data": base64.b64encode(pcm16k).decode(),
                                            }
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
            finally:
                self._ws = None

    async def send_tool_result(self, call_id: str | None, name: str, result: dict) -> None:
        """See RealtimeProvider.send_tool_result. Gemini Live has no
        vendor-supplied call_id in every case (`ToolCall.call_id` is the
        `functionCall.id` when present) - `id` is included only when the
        vendor gave us one, per the BidiGenerateContent functionResponse
        shape."""
        if self._ws is None:
            logger.warning("send_tool_result called with no live session; dropping result for %s", name)
            return
        response: dict = {"name": name, "response": result}
        if call_id is not None:
            response["id"] = call_id
        await self._ws.send(json.dumps({"toolResponse": {"functionResponses": [response]}}))

    async def update_session(self, instructions: str, tools: list[ToolSpec] | None) -> None:
        """Documented no-op - see the class docstring. Gemini Live's `setup`
        is send-once-at-connection; there is no message in this package's
        BidiGenerateContent implementation that changes it mid-session. The
        workflow publish-time validator rejects WORKFLOW + Gemini realtime
        specifically so this is never reached in production; if it is,
        that's a bug upstream of this class, not something to silently
        paper over here."""
        logger.warning(
            "update_session called on GeminiRealtime, which cannot update a live session - "
            "instructions NOT changed (this should be unreachable; the workflow validator "
            "should have rejected WORKFLOW mode + Gemini realtime at publish time)"
        )
