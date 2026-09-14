import httpx
import pytest

from config_client import ConfigClient, ConfigFetchError, parse_agent_config

FIXTURE_PAYLOAD = {
    "agentId": "agent-1",
    "extensionNumber": "2001",
    "language": "en-IN",
    "greeting": "This is an automated call from Algo PBX support.",
    "systemPrompt": "You are a helpful support agent.",
    "pipelineMode": "CASCADE",
    "stt": {"provider": "deepgram", "model": "nova-2", "apiKey": "dg-key", "region": None},
    "llm": {"provider": "openai_compatible", "model": "gpt-4o-mini", "apiKey": "llm-key", "baseUrl": "https://api.openai.com/v1"},
    "tts": {"provider": "elevenlabs", "model": "eleven_turbo_v2_5", "voice": "rachel", "apiKey": "tts-key", "region": None},
    "tools": None,
    "outboundEnabled": False,
    "handoffExtensionHint": "support_queue",
}


def test_parse_agent_config_full_cascade_payload():
    config = parse_agent_config(FIXTURE_PAYLOAD)
    assert config.agent_id == "agent-1"
    assert config.pipeline_mode == "CASCADE"
    assert config.is_realtime is False
    assert config.stt.provider == "deepgram"
    assert config.stt.api_key == "dg-key"
    assert config.llm.base_url == "https://api.openai.com/v1"
    assert config.tts.voice == "rachel"
    assert config.realtime is None
    assert config.outbound_enabled is False
    assert config.handoff_extension_hint == "support_queue"


def test_parse_agent_config_realtime_payload_omits_cascade_legs():
    payload = dict(FIXTURE_PAYLOAD)
    payload["pipelineMode"] = "REALTIME"
    payload["realtime"] = {"provider": "openai", "model": "gpt-4o-realtime-preview", "apiKey": "rt-key", "region": None}
    del payload["stt"]
    del payload["llm"]
    del payload["tts"]

    config = parse_agent_config(payload)
    assert config.is_realtime is True
    assert config.realtime.provider == "openai"
    assert config.stt is None
    assert config.llm is None
    assert config.tts is None


def test_parse_agent_config_missing_required_field_raises_keyerror():
    payload = dict(FIXTURE_PAYLOAD)
    del payload["agentId"]
    with pytest.raises(KeyError):
        parse_agent_config(payload)


@pytest.mark.asyncio
async def test_config_client_sends_shared_secret_header_and_params(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return FIXTURE_PAYLOAD

        text = ""

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, params=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["params"] = params
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    client = ConfigClient(base_url="http://sidecar-test.internal", shared_secret="s3cret")
    config = await client.fetch(extension="2001", tenant_id="tenant-abc")

    assert config.agent_id == "agent-1"
    assert captured["url"] == "http://sidecar-test.internal/api/internal/ai/agent-config"
    assert captured["headers"] == {"x-internal-secret": "s3cret"}
    assert captured["params"] == {"ext": "2001", "tenant": "tenant-abc"}


@pytest.mark.asyncio
async def test_config_client_raises_on_non_200(monkeypatch):
    class FakeResponse:
        status_code = 401
        text = "unauthorized"

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, params=None):
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    client = ConfigClient(base_url="http://sidecar-test.internal", shared_secret="s3cret")
    with pytest.raises(ConfigFetchError):
        await client.fetch(extension="2001", tenant_id="tenant-abc")


@pytest.mark.asyncio
async def test_config_client_wraps_transport_errors(monkeypatch):
    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, params=None):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    client = ConfigClient(base_url="http://sidecar-test.internal", shared_secret="s3cret")
    with pytest.raises(ConfigFetchError):
        await client.fetch(extension="2001", tenant_id="tenant-abc")
