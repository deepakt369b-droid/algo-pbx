"""Realtime speech-to-speech via OpenAI's `/v1/realtime` websocket.

Unlike Gemini Live (see gemini.py), OpenAI's Realtime API accepts and
returns `g711_ulaw` audio directly at 8kHz when `input_audio_format` /
`output_audio_format` are set to `g711_ulaw` in the session config - this
matches AudioSocket's native ulaw framing option exactly, so NO resampling
is needed here (the one place in this package it's avoidable). If the
AudioSocket leg is running slin16 instead of ulaw, the caller is responsible
for mulaw<->slin16 companding at the AudioSocket boundary (see
audiosocket/protocol.py's FRAME_MS/SLIN_FRAME_BYTES notes) - not this
provider's concern.

ASSUMPTION: exact `session.update`/`input_audio_buffer.append`/
`response.audio.delta` event names reconstructed from OpenAI's public
Realtime API documentation from general knowledge, not verified live.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable

logger = logging.getLogger(__name__)

import websockets

from ..base import OutgoingAudioSink, ProviderLegConfig, ToolCall, ToolSpec

DEFAULT_WS_URL = "wss://api.openai.com/v1/realtime"


@dataclass
class OpenAiRealtime:
    config: ProviderLegConfig
    system_prompt: str = ""
    voice: str = "alloy"
    _ws: "websockets.WebSocketClientProtocol | None" = field(default=None, init=False, repr=False)

    @property
    def ws_url(self) -> str:
        base = self.config.base_url or DEFAULT_WS_URL
        model = self.config.model or "gpt-4o-realtime-preview"
        return f"{base}?model={model}"

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.config.api_key}",
            "OpenAI-Beta": "realtime=v1",
        }

    def _session_payload(self, instructions: str, tools: list[ToolSpec] | None) -> dict:
        session: dict = {
            "modalities": ["audio", "text"],
            "instructions": instructions,
            "voice": self.config.voice or self.voice,
            "input_audio_format": "g711_ulaw",
            "output_audio_format": "g711_ulaw",
            "turn_detection": {"type": "server_vad"},
        }
        temperature = self.config.extra.get("temperature")
        if temperature is not None:
            session["temperature"] = temperature
        if tools:
            # OpenAI Realtime's tool shape is FLAT (name/description/parameters
            # at the top level), unlike Chat Completions' nested
            # {type:"function", function:{...}} - see openai_compatible.py's
            # _tools_payload for the contrasting shape.
            session["tools"] = [
                {"type": "function", "name": t.name, "description": t.description, "parameters": t.parameters}
                for t in tools
            ]
            session["tool_choice"] = "auto"
        return session

    async def run(
        self,
        audio_in: AsyncIterator[bytes],
        audio_out: OutgoingAudioSink,
        *,
        tools: list[ToolSpec] | None = None,
        on_tool_call: "Callable[[ToolCall], Awaitable[None]] | None" = None,
    ) -> None:
        async with websockets.connect(self.ws_url, additional_headers=self._headers(), max_size=None) as ws:
            self._ws = ws
            try:
                session = self._session_payload(self.system_prompt, tools)
                await ws.send(json.dumps({"type": "session.update", "session": session}))

                async def sender() -> None:
                    async for chunk in audio_in:
                        await ws.send(
                            json.dumps(
                                {
                                    "type": "input_audio_buffer.append",
                                    "audio": base64.b64encode(chunk).decode(),
                                }
                            )
                        )

                send_task = asyncio.create_task(sender())
                # Function calls arrive as: response.output_item.added (type
                # "function_call", carrying name/call_id keyed by item_id) ->
                # response.function_call_arguments.delta (JSON text fragments,
                # keyed by item_id) -> response.function_call_arguments.done
                # (full arguments string). Accumulated per item_id since a
                # response can contain more than one call.
                pending_calls: dict[str, dict] = {}
                try:
                    async for raw in ws:
                        event = json.loads(raw)
                        event_type = event.get("type")
                        if event_type == "response.audio.delta":
                            audio_out.push(base64.b64decode(event["delta"]))
                        elif event_type == "input_audio_buffer.speech_started":
                            # Caller started talking over the bot: stop playback
                            # and flush queued outbound audio (barge-in).
                            audio_out.barge_in_stop()
                        elif event_type == "response.output_item.added":
                            item = event.get("item") or {}
                            if item.get("type") == "function_call":
                                pending_calls[item["id"]] = {
                                    "name": item.get("name", ""),
                                    "call_id": item.get("call_id"),
                                    "arguments": "",
                                }
                        elif event_type == "response.function_call_arguments.delta":
                            item_id = event.get("item_id")
                            if item_id in pending_calls:
                                pending_calls[item_id]["arguments"] += event.get("delta", "")
                        elif event_type == "response.function_call_arguments.done":
                            item_id = event.get("item_id")
                            pending = pending_calls.pop(item_id, None)
                            if pending is not None and on_tool_call is not None:
                                arguments_text = event.get("arguments", pending["arguments"])
                                try:
                                    arguments = json.loads(arguments_text) if arguments_text else {}
                                except json.JSONDecodeError:
                                    arguments = {}
                                await on_tool_call(
                                    ToolCall(name=pending["name"], arguments=arguments, call_id=pending["call_id"])
                                )
                        elif event_type == "response.done":
                            continue
                finally:
                    send_task.cancel()
            finally:
                self._ws = None

    async def send_tool_result(self, call_id: str | None, name: str, result: dict) -> None:
        """See RealtimeProvider.send_tool_result. `call_id` is required by
        OpenAI's `function_call_output` item - if the runner somehow has none
        (should not happen for this provider; OpenAI always supplies one),
        the result is dropped with a log rather than sending a malformed item
        that would desync the session."""
        if self._ws is None:
            logger.warning("send_tool_result called with no live session; dropping result for %s", name)
            return
        if call_id is None:
            logger.warning("send_tool_result for %s has no call_id; dropping (OpenAI requires one)", name)
            return
        await self._ws.send(
            json.dumps(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": json.dumps(result),
                    },
                }
            )
        )
        await self._ws.send(json.dumps({"type": "response.create"}))

    async def update_session(self, instructions: str, tools: list[ToolSpec] | None) -> None:
        """OpenAI Realtime supports genuine mid-session updates - the
        mechanism a workflow node transition uses to move this provider to a
        new node without dropping the connection."""
        if self._ws is None:
            logger.warning("update_session called with no live session; dropping")
            return
        session = self._session_payload(instructions, tools)
        await self._ws.send(json.dumps({"type": "session.update", "session": session}))
