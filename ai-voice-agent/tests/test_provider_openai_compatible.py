import httpx
import pytest

from pipeline.base import ChatMessage, ProviderLegConfig
from pipeline.providers.openai_compatible import OpenAiCompatibleLlm


def _config(**overrides) -> ProviderLegConfig:
    base = dict(provider="openai_compatible", model="gpt-4o-mini", api_key="sk-test")
    base.update(overrides)
    return ProviderLegConfig(**base)


def test_base_url_defaults_to_openai():
    llm = OpenAiCompatibleLlm(config=_config())
    assert llm.base_url == "https://api.openai.com/v1"


def test_base_url_respects_override_and_strips_trailing_slash():
    llm = OpenAiCompatibleLlm(config=_config(base_url="https://openrouter.ai/api/v1/"))
    assert llm.base_url == "https://openrouter.ai/api/v1"


def test_headers_include_bearer_token():
    llm = OpenAiCompatibleLlm(config=_config(api_key="sk-abc123"))
    headers = llm._headers()
    assert headers["Authorization"] == "Bearer sk-abc123"
    assert headers["Content-Type"] == "application/json"


def test_body_shapes_messages_and_stream_flag():
    llm = OpenAiCompatibleLlm(config=_config(model="llama-3.1-70b"))
    messages = [ChatMessage(role="system", content="Be terse."), ChatMessage(role="user", content="Hi")]
    body = llm._body(messages, stream=True)
    assert body == {
        "model": "llama-3.1-70b",
        "messages": [
            {"role": "system", "content": "Be terse."},
            {"role": "user", "content": "Hi"},
        ],
        "stream": True,
    }


@pytest.mark.asyncio
async def test_generate_streams_sse_content_deltas(monkeypatch):
    sse_lines = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        "data: [DONE]",
    ]

    class FakeStreamResponse:
        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            for line in sse_lines:
                yield line

    class FakeStreamCtx:
        async def __aenter__(self):
            return FakeStreamResponse()

        async def __aexit__(self, *exc):
            return False

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def stream(self, method, url, headers=None, json=None):
            assert method == "POST"
            assert url == "https://api.openai.com/v1/chat/completions"
            assert json["stream"] is True
            return FakeStreamCtx()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    llm = OpenAiCompatibleLlm(config=_config())
    deltas = [d async for d in llm.generate([ChatMessage(role="user", content="hi")])]
    assert [d.text for d in deltas] == ["Hel", "lo"]
    assert all(d.tool_call is None for d in deltas)
