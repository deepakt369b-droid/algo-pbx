import pytest

from handoff import AmiActionError, redirect_to_extension


class FakeAmiClient:
    def __init__(self, response=None):
        self.sent: list[dict] = []
        self._response = response or {"Response": "Success", "ActionID": "1"}
        self.connected = False
        self.closed = False

    async def connect(self):
        self.connected = True

    async def send(self, fields: dict) -> dict:
        self.sent.append(fields)
        return self._response

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_redirect_sends_expected_action_shape():
    fake = FakeAmiClient()
    await redirect_to_extension(
        channel="PJSIP/2001-00000001",
        context="from-ai-agent",
        extension="support_queue",
        client=fake,
    )
    assert fake.sent == [
        {
            "Action": "Redirect",
            "Channel": "PJSIP/2001-00000001",
            "Context": "from-ai-agent",
            "Exten": "support_queue",
            "Priority": "1",
        }
    ]
    # An injected client is assumed already connected/owned by the caller -
    # redirect_to_extension should not call connect()/close() on it.
    assert fake.connected is False
    assert fake.closed is False


@pytest.mark.asyncio
async def test_redirect_raises_on_ami_error_response():
    fake = FakeAmiClient(response={"Response": "Error", "Message": "No such channel"})
    with pytest.raises(AmiActionError):
        await redirect_to_extension(
            channel="PJSIP/does-not-exist",
            context="from-ai-agent",
            extension="support_queue",
            client=fake,
        )


def test_frame_action_rejects_crlf_injection():
    from handoff import AmiClient

    client = AmiClient(host="localhost", port=5038, username="u", secret="s")
    with pytest.raises(ValueError):
        client._frame_action({"Action": "Redirect", "Channel": "PJSIP/1\r\nAction: Command"})


def test_frame_action_produces_wire_format_with_actionid():
    from handoff import AmiClient

    client = AmiClient(host="localhost", port=5038, username="u", secret="s")
    action_id, message = client._frame_action({"Action": "Redirect", "Channel": "PJSIP/2001-1"})
    assert message.decode() == (
        f"ActionID: {action_id}\r\nAction: Redirect\r\nChannel: PJSIP/2001-1\r\n\r\n"
    )
