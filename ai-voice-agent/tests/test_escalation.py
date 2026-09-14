import pytest

from escalation import EscalationClient, EscalationController, EscalationRequestError


class FakeClient:
    def __init__(
        self,
        *,
        check_result=None,
        check_raises=None,
        merge_result=None,
        merge_raises=None,
        callback_result=None,
        callback_raises=None,
    ):
        self._check_result = check_result
        self._check_raises = check_raises
        self._merge_result = merge_result
        self._merge_raises = merge_raises
        self._callback_result = callback_result
        self._callback_raises = callback_raises
        self.check_calls: list[dict] = []
        self.merge_calls: list[dict] = []
        self.callback_calls: list[dict] = []

    async def check(self, *, agent_id: str, call_uuid: str) -> dict:
        self.check_calls.append({"agent_id": agent_id, "call_uuid": call_uuid})
        if self._check_raises:
            raise self._check_raises
        return self._check_result

    async def merge(self, *, agent_id: str, call_uuid: str) -> dict:
        self.merge_calls.append({"agent_id": agent_id, "call_uuid": call_uuid})
        if self._merge_raises:
            raise self._merge_raises
        return self._merge_result

    async def callback(self, *, agent_id: str, call_uuid: str, reason=None) -> dict:
        self.callback_calls.append({"agent_id": agent_id, "call_uuid": call_uuid, "reason": reason})
        if self._callback_raises:
            raise self._callback_raises
        return self._callback_result


def _controller(client: FakeClient, spoken: list[str]) -> EscalationController:
    async def speak(text: str) -> None:
        spoken.append(text)

    return EscalationController(agent_id="agent-1", call_uuid="call-1", speak=speak, client=client)


@pytest.mark.asyncio
async def test_request_handoff_speaks_announce_line_first():
    client = FakeClient(check_result={"available": False, "reason": "no_target_configured"})
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_handoff("caller asked")

    assert spoken[0] == "Let me get a colleague on the line, one moment."
    assert outcome.merged is False
    assert client.check_calls == [{"agent_id": "agent-1", "call_uuid": "call-1"}]
    assert client.merge_calls == []  # never attempted when check says unavailable


@pytest.mark.asyncio
async def test_unavailable_reasons_speak_a_message_and_do_not_merge():
    client = FakeClient(check_result={"available": False, "reason": "gsm_capacity"})
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_handoff("caller asked")

    assert outcome == outcome  # sanity
    assert outcome.merged is False
    assert outcome.reason == "gsm_capacity"
    assert "busy" in spoken[-1]


@pytest.mark.asyncio
async def test_unknown_reason_falls_back_to_generic_message():
    client = FakeClient(check_result={"available": False, "reason": "some_future_reason_not_in_the_dict"})
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_handoff("caller asked")

    assert outcome.merged is False
    assert spoken[-1].startswith("I'm not able to transfer you right now, but let me keep helping.")


@pytest.mark.asyncio
async def test_caller_hung_up_speaks_nothing_after_the_announce_line():
    client = FakeClient(check_result={"available": True, "targetKind": "EXTENSION", "targetLabel": "1002"})
    client._merge_result = {"merged": False, "reason": "caller_hung_up"}
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_handoff("caller asked")

    assert outcome.merged is False
    assert outcome.reason == "caller_hung_up"
    # Only the initial "one moment" line - no apology to a caller who's gone.
    assert spoken == ["Let me get a colleague on the line, one moment."]


@pytest.mark.asyncio
async def test_check_request_failure_is_reported_as_unavailable():
    client = FakeClient(check_raises=EscalationRequestError("boom"))
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_handoff("caller asked")

    assert outcome.merged is False
    assert outcome.reason == "check_request_failed"
    assert len(spoken) == 2  # announce line + apology


@pytest.mark.asyncio
async def test_merge_request_failure_is_reported_as_unavailable():
    client = FakeClient(check_result={"available": True}, merge_raises=EscalationRequestError("boom"))
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_handoff("caller asked")

    assert outcome.merged is False
    assert outcome.reason == "merge_request_failed"


@pytest.mark.asyncio
async def test_successful_merge_speaks_nothing_further_and_returns_target_info():
    client = FakeClient(
        check_result={"available": True, "targetKind": "NUMBER", "targetLabel": "+971501234567"},
        merge_result={"merged": True, "targetLabel": "+971501234567", "humanAnswered": True},
    )
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_handoff("caller asked")

    assert outcome.merged is True
    assert outcome.target_label == "+971501234567"
    assert outcome.human_answered is True
    # Nothing spoken after the initial "one moment" line - the caller has
    # already been redirected out of this connection by the time merge()
    # returns.
    assert spoken == ["Let me get a colleague on the line, one moment."]


@pytest.mark.asyncio
async def test_request_callback_success_speaks_confirmation_and_passes_reason():
    client = FakeClient(callback_result={"created": True, "taskId": "task-1"})
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_callback("caller wants a callback about billing")

    assert outcome.created is True
    assert outcome.task_id == "task-1"
    assert spoken == ["Done - someone will call you back soon."]
    assert client.callback_calls == [
        {"agent_id": "agent-1", "call_uuid": "call-1", "reason": "caller wants a callback about billing"}
    ]


@pytest.mark.asyncio
async def test_request_callback_empty_reason_sent_as_none():
    client = FakeClient(callback_result={"created": True, "taskId": "task-1"})
    spoken: list[str] = []
    await _controller(client, spoken).request_callback("")

    assert client.callback_calls[0]["reason"] is None


@pytest.mark.asyncio
async def test_request_callback_failure_speaks_apology_and_reports_reason():
    client = FakeClient(callback_result={"created": False, "reason": "no_assignee_available"})
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_callback("caller asked")

    assert outcome.created is False
    assert outcome.reason == "no_assignee_available"
    assert spoken == ["Sorry, I wasn't able to arrange that callback right now. Let me keep helping."]


@pytest.mark.asyncio
async def test_request_callback_unknown_reason_falls_back_to_generic_message():
    client = FakeClient(callback_result={"created": False, "reason": "some_future_reason"})
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_callback("caller asked")

    assert outcome.created is False
    assert spoken == ["Sorry, I wasn't able to arrange that callback. Let me keep helping."]


@pytest.mark.asyncio
async def test_request_callback_http_failure_is_reported_as_not_created():
    client = FakeClient(callback_raises=EscalationRequestError("boom"))
    spoken: list[str] = []
    outcome = await _controller(client, spoken).request_callback("caller asked")

    assert outcome.created is False
    assert outcome.reason == "callback_request_failed"


class _FakeAsyncClient:
    """Minimal httpx.AsyncClient stand-in for EscalationClient's own _post,
    exercised directly (not through EscalationController) so the HTTP-shape
    contract (headers, body, non-200 handling) is covered independent of
    the controller's flow logic above."""

    def __init__(self, status_code: int, json_body=None, text: str = ""):
        self.status_code = status_code
        self._json_body = json_body
        self.text = text
        self.sent = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        self.sent = {"url": url, "headers": headers, "json": json}
        return self

    def json(self):
        return self._json_body


@pytest.mark.asyncio
async def test_client_sends_shared_secret_header_and_action_body(monkeypatch):
    import httpx

    fake_resp = _FakeAsyncClient(200, {"available": True})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: fake_resp)

    client = EscalationClient(base_url="http://127.0.0.1:3000", shared_secret="s3cret")
    result = await client.check(agent_id="agent-1", call_uuid="call-1")

    assert result == {"available": True}
    assert fake_resp.sent["url"] == "http://127.0.0.1:3000/api/internal/ai/escalate"
    assert fake_resp.sent["headers"]["x-internal-secret"] == "s3cret"
    assert fake_resp.sent["json"] == {"action": "check", "agentId": "agent-1", "callUuid": "call-1"}


@pytest.mark.asyncio
async def test_client_raises_on_non_200(monkeypatch):
    import httpx

    fake_resp = _FakeAsyncClient(500, text="internal error")
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: fake_resp)

    client = EscalationClient(base_url="http://127.0.0.1:3000", shared_secret="s3cret")
    with pytest.raises(EscalationRequestError):
        await client.merge(agent_id="agent-1", call_uuid="call-1")
