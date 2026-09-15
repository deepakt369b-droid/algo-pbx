"""Tests for the realtime tool-result-feedback fix: `send_tool_result` and
`update_session` on OpenAiRealtime/GeminiRealtime (pipeline/base.py's
RealtimeProvider Protocol). Exercises the exact JSON envelope each vendor
expects, plus the "no live session yet" no-op guard - the same
"reconstructed from public docs, not verified live" caveat every other test
of these two modules carries (see each provider module's own docstring).
"""

import json

import pytest
import websockets

from pipeline.base import ProviderLegConfig, ToolSpec
from pipeline.providers.gemini import GeminiRealtime
from pipeline.providers.openai_realtime import OpenAiRealtime


class _FakeWs:
    def __init__(self, incoming=None):
        self.sent: list[str] = []
        self._incoming = incoming or []

    async def send(self, data: str) -> None:
        self.sent.append(data)

    def __aiter__(self):
        return self._aiter()

    async def _aiter(self):
        for item in self._incoming:
            yield item


class _FakeConnectCtx:
    def __init__(self, ws: _FakeWs):
        self._ws = ws

    async def __aenter__(self):
        return self._ws

    async def __aexit__(self, *exc):
        return False


async def _empty_audio():
    return
    yield  # pragma: no cover - makes this an async generator with no items


class _FakeAudioSink:
    def push(self, chunk: bytes) -> None:
        pass

    def barge_in_stop(self) -> None:
        pass


def _openai_realtime(**overrides) -> OpenAiRealtime:
    base = dict(provider="openai", model="gpt-4o-realtime-preview", api_key="sk-test")
    base.update(overrides.pop("config_overrides", {}))
    return OpenAiRealtime(config=ProviderLegConfig(**base), **overrides)


def _gemini_realtime(**overrides) -> GeminiRealtime:
    base = dict(provider="gemini", model="gemini-2.0-flash-live", api_key="key")
    base.update(overrides.pop("config_overrides", {}))
    return GeminiRealtime(config=ProviderLegConfig(**base), **overrides)


# --- OpenAI Realtime -----------------------------------------------------


@pytest.mark.asyncio
async def test_openai_realtime_send_tool_result_envelope(monkeypatch):
    fake_ws = _FakeWs()
    monkeypatch.setattr(websockets, "connect", lambda *a, **kw: _FakeConnectCtx(fake_ws))

    provider = _openai_realtime()
    await provider.run(_empty_audio(), _FakeAudioSink())  # establishes self._ws, then returns (no incoming events)
    # run() clears self._ws in its `finally`; call send_tool_result while a
    # session is conceptually "live" by re-priming it, matching how the
    # runner actually invokes it (from within on_tool_call, mid-`run`).
    provider._ws = fake_ws

    await provider.send_tool_result("call_1", "check_slots", {"ok": True, "slots": ["10am"]})

    assert json.loads(fake_ws.sent[-2]) == {
        "type": "conversation.item.create",
        "item": {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": json.dumps({"ok": True, "slots": ["10am"]}),
        },
    }
    assert json.loads(fake_ws.sent[-1]) == {"type": "response.create"}


@pytest.mark.asyncio
async def test_openai_realtime_send_tool_result_noop_with_no_live_session():
    provider = _openai_realtime()
    # No run() has happened; self._ws is None. Must not raise.
    await provider.send_tool_result("call_1", "check_slots", {"ok": True})


@pytest.mark.asyncio
async def test_openai_realtime_send_tool_result_noop_with_no_call_id():
    provider = _openai_realtime()
    provider._ws = _FakeWs()
    await provider.send_tool_result(None, "check_slots", {"ok": True})
    assert provider._ws.sent == []


@pytest.mark.asyncio
async def test_openai_realtime_update_session_sends_new_instructions_and_tools():
    provider = _openai_realtime()
    provider._ws = _FakeWs()
    tool = ToolSpec(name="goto_next", description="move to the next step", parameters={})

    await provider.update_session("You are now at step 2.", [tool])

    sent = json.loads(provider._ws.sent[-1])
    assert sent["type"] == "session.update"
    assert sent["session"]["instructions"] == "You are now at step 2."
    assert sent["session"]["tools"] == [
        {"type": "function", "name": "goto_next", "description": "move to the next step", "parameters": {}}
    ]


# --- Gemini Realtime -------------------------------------------------------


@pytest.mark.asyncio
async def test_gemini_realtime_setup_includes_system_instruction(monkeypatch):
    fake_ws = _FakeWs()
    monkeypatch.setattr(websockets, "connect", lambda *a, **kw: _FakeConnectCtx(fake_ws))

    provider = _gemini_realtime(system_prompt="You are a helpful agent.")
    await provider.run(_empty_audio(), _FakeAudioSink())

    setup = json.loads(fake_ws.sent[0])["setup"]
    assert setup["systemInstruction"] == {"parts": [{"text": "You are a helpful agent."}]}


@pytest.mark.asyncio
async def test_gemini_realtime_setup_omits_system_instruction_when_empty(monkeypatch):
    fake_ws = _FakeWs()
    monkeypatch.setattr(websockets, "connect", lambda *a, **kw: _FakeConnectCtx(fake_ws))

    provider = _gemini_realtime()
    await provider.run(_empty_audio(), _FakeAudioSink())

    setup = json.loads(fake_ws.sent[0])["setup"]
    assert "systemInstruction" not in setup


@pytest.mark.asyncio
async def test_gemini_realtime_send_tool_result_envelope():
    provider = _gemini_realtime()
    provider._ws = _FakeWs()

    await provider.send_tool_result("fc_1", "check_slots", {"ok": True, "slots": ["10am"]})

    assert json.loads(provider._ws.sent[-1]) == {
        "toolResponse": {
            "functionResponses": [{"name": "check_slots", "response": {"ok": True, "slots": ["10am"]}, "id": "fc_1"}]
        }
    }


@pytest.mark.asyncio
async def test_gemini_realtime_send_tool_result_omits_id_when_none():
    provider = _gemini_realtime()
    provider._ws = _FakeWs()

    await provider.send_tool_result(None, "check_slots", {"ok": True})

    sent = json.loads(provider._ws.sent[-1])
    assert "id" not in sent["toolResponse"]["functionResponses"][0]


@pytest.mark.asyncio
async def test_gemini_realtime_update_session_is_a_logged_noop(caplog):
    provider = _gemini_realtime()
    provider._ws = _FakeWs()

    await provider.update_session("new instructions", None)

    assert provider._ws.sent == []
    assert any("cannot update a live session" in r.message for r in caplog.records)
