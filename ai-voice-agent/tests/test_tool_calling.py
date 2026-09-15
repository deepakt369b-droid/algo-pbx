import json

import httpx
import pytest

from pipeline.base import ChatMessage, ProviderLegConfig, ToolCall, ToolSpec
from pipeline.providers.gemini import GeminiLlm
from pipeline.providers.openai_compatible import OpenAiCompatibleLlm


def _openai_config(**overrides) -> ProviderLegConfig:
    base = dict(provider="openai_compatible", model="gpt-4o-mini", api_key="sk-test")
    base.update(overrides)
    return ProviderLegConfig(**base)


def _gemini_config(**overrides) -> ProviderLegConfig:
    base = dict(provider="gemini", model="gemini-2.0-flash", api_key="key")
    base.update(overrides)
    return ProviderLegConfig(**base)


HANDOFF_TOOL = ToolSpec(
    name="request_human_handoff",
    description="Escalate to a human.",
    parameters={"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]},
)


class _FakeStreamResponse:
    def __init__(self, lines):
        self._lines = lines

    def raise_for_status(self):
        pass

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeStreamCtx:
    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return _FakeStreamResponse(self._lines)

    async def __aexit__(self, *exc):
        return False


class _FakeAsyncClient:
    def __init__(self, lines):
        self._lines = lines

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, method, url, headers=None, json=None):
        self.sent_body = json
        return _FakeStreamCtx(self._lines)


@pytest.mark.asyncio
async def test_openai_compatible_sends_tools_payload(monkeypatch):
    fake_client = _FakeAsyncClient(["data: [DONE]"])
    monkeypatch.setattr(httpx, "AsyncClient", fake_client)

    llm = OpenAiCompatibleLlm(config=_openai_config())
    _ = [d async for d in llm.generate([ChatMessage(role="user", content="hi")], tools=[HANDOFF_TOOL])]

    assert fake_client.sent_body["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "request_human_handoff",
                "description": "Escalate to a human.",
                "parameters": HANDOFF_TOOL.parameters,
            },
        }
    ]


@pytest.mark.asyncio
async def test_openai_compatible_accumulates_streamed_tool_call(monkeypatch):
    lines = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"request_human_handoff","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"reason\\": "}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"caller asked\\"}"}}]}}],"finish_reason":null}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
    ]
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient(lines))

    llm = OpenAiCompatibleLlm(config=_openai_config())
    deltas = [d async for d in llm.generate([ChatMessage(role="user", content="hi")], tools=[HANDOFF_TOOL])]

    tool_deltas = [d for d in deltas if d.tool_call is not None]
    assert len(tool_deltas) == 1
    call = tool_deltas[0].tool_call
    assert call.name == "request_human_handoff"
    assert call.call_id == "call_1"
    assert call.arguments == {"reason": "caller asked"}


@pytest.mark.asyncio
async def test_openai_compatible_tolerates_malformed_tool_arguments(monkeypatch):
    lines = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"request_human_handoff","arguments":"not json"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
    ]
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient(lines))

    llm = OpenAiCompatibleLlm(config=_openai_config())
    deltas = [d async for d in llm.generate([ChatMessage(role="user", content="hi")], tools=[HANDOFF_TOOL])]

    call = next(d.tool_call for d in deltas if d.tool_call is not None)
    assert call.arguments == {}


@pytest.mark.asyncio
async def test_gemini_parses_function_call(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {"functionCall": {"name": "request_human_handoff", "args": {"reason": "caller asked"}}}
                            ]
                        }
                    }
                ]
            }

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None):
            self.sent_body = json
            FakeClient.last_body = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    llm = GeminiLlm(config=_gemini_config())
    deltas = [d async for d in llm.generate([ChatMessage(role="user", content="hi")], tools=[HANDOFF_TOOL])]

    assert len(deltas) == 1
    assert deltas[0].tool_call.name == "request_human_handoff"
    assert deltas[0].tool_call.arguments == {"reason": "caller asked"}
    assert FakeClient.last_body["tools"] == [
        {
            "functionDeclarations": [
                {
                    "name": "request_human_handoff",
                    "description": "Escalate to a human.",
                    "parameters": HANDOFF_TOOL.parameters,
                }
            ]
        }
    ]


@pytest.mark.asyncio
async def test_gemini_plain_text_response_has_no_tool_call(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "hello there"}]}}]}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None):
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    llm = GeminiLlm(config=_gemini_config())
    deltas = [d async for d in llm.generate([ChatMessage(role="user", content="hi")])]

    assert len(deltas) == 1
    assert deltas[0].text == "hello there"
    assert deltas[0].tool_call is None


# --- Tool-result feedback: serialization of the assistant-with-tool_calls /
# tool-role message pair back into each vendor's wire format. This is the
# fix for "tool results are never fed back to the LLM" - see
# `pipeline/runner.py`'s `_generate_turn_reply`. ------------------------------


@pytest.mark.asyncio
async def test_openai_compatible_serializes_tool_call_and_result_messages(monkeypatch):
    fake_client = _FakeAsyncClient(["data: [DONE]"])
    monkeypatch.setattr(httpx, "AsyncClient", fake_client)

    messages = [
        ChatMessage(role="user", content="book me a slot"),
        ChatMessage(
            role="assistant",
            content="",
            tool_calls=[ToolCall(name="check_slots", arguments={"day": "mon"}, call_id="call_1")],
        ),
        ChatMessage(role="tool", content=json.dumps({"ok": True, "slots": ["10am"]}), tool_call_id="call_1", name="check_slots"),
    ]

    llm = OpenAiCompatibleLlm(config=_openai_config())
    _ = [d async for d in llm.generate(messages)]

    sent = fake_client.sent_body["messages"]
    assert sent[1] == {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "check_slots", "arguments": '{"day": "mon"}'}}
        ],
    }
    assert sent[2] == {
        "role": "tool",
        "tool_call_id": "call_1",
        "content": '{"ok": true, "slots": ["10am"]}',
        "name": "check_slots",
    }


@pytest.mark.asyncio
async def test_openai_compatible_sends_temperature_and_max_tokens_only_when_set(monkeypatch):
    fake_client = _FakeAsyncClient(["data: [DONE]"])
    monkeypatch.setattr(httpx, "AsyncClient", fake_client)

    llm = OpenAiCompatibleLlm(config=_openai_config(extra={"temperature": 0.4, "max_tokens": 200}))
    _ = [d async for d in llm.generate([ChatMessage(role="user", content="hi")])]
    assert fake_client.sent_body["temperature"] == 0.4
    assert fake_client.sent_body["max_tokens"] == 200

    fake_client2 = _FakeAsyncClient(["data: [DONE]"])
    monkeypatch.setattr(httpx, "AsyncClient", fake_client2)
    llm2 = OpenAiCompatibleLlm(config=_openai_config())
    _ = [d async for d in llm2.generate([ChatMessage(role="user", content="hi")])]
    assert "temperature" not in fake_client2.sent_body
    assert "max_tokens" not in fake_client2.sent_body


@pytest.mark.asyncio
async def test_gemini_serializes_tool_call_and_result_as_function_call_response(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "ok, 10am works"}]}}]}

    class FakeClient:
        last_body = None

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None):
            FakeClient.last_body = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    messages = [
        ChatMessage(role="user", content="book me a slot"),
        ChatMessage(
            role="assistant",
            content="",
            tool_calls=[ToolCall(name="check_slots", arguments={"day": "mon"})],
        ),
        ChatMessage(role="tool", content=json.dumps({"slots": ["10am"]}), name="check_slots"),
    ]

    llm = GeminiLlm(config=_gemini_config())
    _ = [d async for d in llm.generate(messages)]

    contents = FakeClient.last_body["contents"]
    assert contents[1] == {"role": "model", "parts": [{"functionCall": {"name": "check_slots", "args": {"day": "mon"}}}]}
    assert contents[2] == {
        "role": "user",
        "parts": [{"functionResponse": {"name": "check_slots", "response": {"slots": ["10am"]}}}],
    }


@pytest.mark.asyncio
async def test_gemini_sends_generation_config_only_when_extra_set(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": "hi"}]}}]}

    class FakeClient:
        last_body = None

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None):
            FakeClient.last_body = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    llm = GeminiLlm(config=_gemini_config(extra={"temperature": 0.7, "max_tokens": 150}))
    _ = [d async for d in llm.generate([ChatMessage(role="user", content="hi")])]
    assert FakeClient.last_body["generationConfig"] == {"temperature": 0.7, "maxOutputTokens": 150}
