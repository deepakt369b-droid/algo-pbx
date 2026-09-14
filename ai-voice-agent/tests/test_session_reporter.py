import httpx
import pytest

from session_reporter import SessionReport, SessionReportError, SessionReporter, TranscriptTurn


def test_session_report_to_payload_omits_none_optionals():
    report = SessionReport(
        agent_id="agent-1",
        cdr_unique_id="cdr-123",
        transcript=[TranscriptTurn(role="agent", text="Hello", at="2026-09-14T00:00:00Z")],
        outcome="completed",
    )
    payload = report.to_payload()
    assert payload == {
        "agentId": "agent-1",
        "cdrUniqueId": "cdr-123",
        "transcript": [{"role": "agent", "text": "Hello", "at": "2026-09-14T00:00:00Z"}],
        "outcome": "completed",
    }


def test_session_report_to_payload_includes_present_optionals():
    report = SessionReport(
        agent_id="agent-1",
        cdr_unique_id="cdr-123",
        transcript=[],
        outcome="handed_off",
        summary="Caller wanted billing help.",
        latency_ms_p50=120.5,
        latency_ms_p95=400.0,
        cost_tokens_input=50,
        cost_tokens_output=80,
        handoff_extension_id="ext-99",
    )
    payload = report.to_payload()
    assert payload["summary"] == "Caller wanted billing help."
    assert payload["latencyMsP50"] == 120.5
    assert payload["latencyMsP95"] == 400.0
    assert payload["costTokensInput"] == 50
    assert payload["costTokensOutput"] == 80
    assert payload["handoffExtensionId"] == "ext-99"


@pytest.mark.asyncio
async def test_reporter_posts_with_shared_secret_header(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200
        text = ""

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    reporter = SessionReporter(base_url="http://sidecar-test.internal", shared_secret="s3cret")
    report = SessionReport(agent_id="a1", cdr_unique_id="c1", transcript=[], outcome="dropped")
    await reporter.report(report)

    assert captured["url"] == "http://sidecar-test.internal/api/internal/ai/sessions"
    assert captured["headers"]["x-internal-secret"] == "s3cret"
    assert captured["json"]["outcome"] == "dropped"


@pytest.mark.asyncio
async def test_reporter_raises_on_error_status(monkeypatch):
    class FakeResponse:
        status_code = 500
        text = "boom"

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, headers=None, json=None):
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    reporter = SessionReporter(base_url="http://sidecar-test.internal", shared_secret="s3cret")
    report = SessionReport(agent_id="a1", cdr_unique_id="c1", transcript=[], outcome="error")
    with pytest.raises(SessionReportError):
        await reporter.report(report)
