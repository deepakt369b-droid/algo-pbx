"""LLM provider for any OpenAI-compatible /chat/completions endpoint.

Covers OpenAI, Groq, OpenRouter, Together, Sarvam-M, and Azure OpenAI, per
the contract's "generic adapter" idea (types.ts's `openai_compatible`
AiProviderKind, plus `openai`/`groq` which use the same wire format). The
only per-vendor variance handled here is `base_url` (defaults to OpenAI's)
and, for Azure, the fact that the deployment name IS the "model" and the API
version is passed as a query param - callers pass that via `extra` on
`ProviderLegConfig` if needed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import AsyncIterator

import httpx

from ..base import ChatMessage, LlmDelta, ProviderLegConfig, ToolCall, ToolSpec

DEFAULT_BASE_URL = "https://api.openai.com/v1"


def _tools_payload(tools: list[ToolSpec]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {"name": t.name, "description": t.description, "parameters": t.parameters},
        }
        for t in tools
    ]


def _message_payload(m: ChatMessage) -> dict:
    """Serialize one ChatMessage to OpenAI's wire shape. An assistant message
    carrying `tool_calls` must send `content: null` (never ""/absent) per
    OpenAI's own spec when tool_calls is present; a `role="tool"` message
    must carry `tool_call_id` and is otherwise rejected."""
    if m.role == "assistant" and m.tool_calls:
        return {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": tc.call_id,
                    "type": "function",
                    "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                }
                for tc in m.tool_calls
            ],
        }
    if m.role == "tool":
        payload: dict = {"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content}
        if m.name:
            payload["name"] = m.name
        return payload
    return {"role": m.role, "content": m.content}


@dataclass
class _PendingToolCall:
    """Accumulates one streamed `tool_calls[<index>]` entry: OpenAI sends the
    id/name once in an early chunk, then streams `arguments` as raw JSON
    text fragments across many chunks - there is no single frame to parse."""

    call_id: str | None = None
    name: str = ""
    arguments_text: str = field(default="")

    def to_tool_call(self) -> ToolCall:
        try:
            arguments = json.loads(self.arguments_text) if self.arguments_text else {}
        except json.JSONDecodeError:
            arguments = {}
        return ToolCall(name=self.name, arguments=arguments, call_id=self.call_id)


@dataclass
class OpenAiCompatibleLlm:
    config: ProviderLegConfig
    timeout_s: float = 30.0

    @property
    def base_url(self) -> str:
        return (self.config.base_url or DEFAULT_BASE_URL).rstrip("/")

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

    def _body(self, messages: list[ChatMessage], *, stream: bool, tools: list[ToolSpec] | None = None) -> dict:
        body: dict = {
            "model": self.config.model,
            "messages": [_message_payload(m) for m in messages],
            "stream": stream,
        }
        if tools:
            body["tools"] = _tools_payload(tools)
        # Optional knobs, sent only when explicitly set (omitting is not the
        # same as sending a provider's own default - some OpenAI-compatible
        # gateways reject unrecognized/None-valued fields outright).
        temperature = self.config.extra.get("temperature")
        if temperature is not None:
            body["temperature"] = temperature
        max_tokens = self.config.extra.get("max_tokens")
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        return body

    async def generate(
        self, messages: list[ChatMessage], tools: list[ToolSpec] | None = None
    ) -> AsyncIterator[LlmDelta]:
        """Stream response deltas via SSE, per the OpenAI chat completions
        streaming format (`data: {...}\\n\\n` lines, terminated by
        `data: [DONE]`). Text deltas are yielded as they arrive; a tool call
        is accumulated across chunks (id/name first, `arguments` as JSON
        fragments) and yielded once complete, on `finish_reason ==
        "tool_calls"`."""
        url = f"{self.base_url}/chat/completions"
        pending_calls: dict[int, _PendingToolCall] = {}
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            async with client.stream(
                "POST", url, headers=self._headers(), json=self._body(messages, stream=True, tools=tools)
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for choice in event.get("choices", []):
                        delta = choice.get("delta", {}) or {}
                        text = delta.get("content")
                        if text:
                            yield LlmDelta(text=text)

                        for tc in delta.get("tool_calls") or []:
                            index = tc.get("index", 0)
                            pending = pending_calls.setdefault(index, _PendingToolCall())
                            if tc.get("id"):
                                pending.call_id = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                pending.name = fn["name"]
                            if fn.get("arguments"):
                                pending.arguments_text += fn["arguments"]

                        if choice.get("finish_reason") == "tool_calls":
                            for pending in pending_calls.values():
                                yield LlmDelta(tool_call=pending.to_tool_call())
                            pending_calls.clear()

    async def generate_sync(self, messages: list[ChatMessage]) -> str:
        """Non-streaming convenience call (used for e.g. summary generation
        at call end, where streaming has no benefit)."""
        url = f"{self.base_url}/chat/completions"
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            resp = await client.post(url, headers=self._headers(), json=self._body(messages, stream=False))
            resp.raise_for_status()
            body = resp.json()
            return body["choices"][0]["message"]["content"]
