import struct

import pytest

from config_client import AiAgentConfig, LegConfig
from pipeline.runner import PipelineRunner, PlayerAudioSink, VOICE_ENERGY_THRESHOLD


def _silent_frame() -> bytes:
    return struct.pack("<160h", *([0] * 160))


def _voiced_frame() -> bytes:
    sample = int(32767 * (VOICE_ENERGY_THRESHOLD + 0.2))
    return struct.pack("<160h", *([sample] * 160))


def _cascade_config(**overrides) -> AiAgentConfig:
    leg = LegConfig(provider="deepgram", model="nova-2", api_key="k")
    base = dict(
        agent_id="agent-1",
        extension_number="500",
        language="en",
        greeting="",
        system_prompt="Be terse.",
        pipeline_mode="CASCADE",
        stt=leg,
        llm=leg,
        tts=leg,
    )
    base.update(overrides)
    return AiAgentConfig(**base)


class FakePlayer:
    def __init__(self):
        self.enqueued: list[bytes] = []
        self.flushed = False

    def enqueue(self, payload: bytes) -> None:
        self.enqueued.append(payload)

    def flush(self) -> None:
        self.flushed = True


class FakeStt:
    def __init__(self, config):
        self.calls = 0

    async def transcribe_stream(self, audio_chunks) -> str:
        chunks = [c async for c in audio_chunks]
        self.calls += 1
        return f"heard {len(chunks)} frames"


class FakeLlm:
    def __init__(self, config):
        pass

    async def generate(self, messages, tools=None):
        from pipeline.base import LlmDelta

        yield LlmDelta(text="ok, ")
        yield LlmDelta(text="thanks")


class FakeTts:
    def __init__(self, config):
        pass

    async def synthesize(self, text: str):
        yield f"audio:{text}".encode()


class FakeLlmEscalates:
    """Yields a tool_call delta instead of text - simulates the model
    deciding the caller needs a human, per pipeline/tools.py."""

    def __init__(self, config):
        pass

    async def generate(self, messages, tools=None):
        from pipeline.base import LlmDelta, ToolCall

        yield LlmDelta(tool_call=ToolCall(name="request_human_handoff", arguments={"reason": "caller asked"}))


class FakeLlmEscalatesThenTalks:
    """Yields a tool_call on the FIRST turn, then normal text on any
    subsequent turn - simulates a blocked/failed escalation followed by the
    conversation continuing normally, per PipelineRunner._run_cascade's
    "clear and keep talking on a non-merge" behavior."""

    def __init__(self, config):
        self._calls = 0

    async def generate(self, messages, tools=None):
        from pipeline.base import LlmDelta, ToolCall

        self._calls += 1
        if self._calls == 1:
            yield LlmDelta(tool_call=ToolCall(name="request_human_handoff", arguments={"reason": "caller asked"}))
        else:
            yield LlmDelta(text="sure, ")
            yield LlmDelta(text="no problem")


class FakeLlmEscalatesThenRequestsCallback:
    """Yields request_human_handoff on the FIRST turn, request_callback on
    the SECOND - simulates a caller who, after being told a transfer isn't
    possible, says they'd like a callback instead."""

    def __init__(self, config):
        self._calls = 0

    async def generate(self, messages, tools=None):
        from pipeline.base import LlmDelta, ToolCall

        self._calls += 1
        if self._calls == 1:
            yield LlmDelta(tool_call=ToolCall(name="request_human_handoff", arguments={"reason": "caller asked"}))
        else:
            yield LlmDelta(tool_call=ToolCall(name="request_callback", arguments={"reason": "billing question"}))


class FakeEscalationController:
    """Stands in for escalation.EscalationController - PipelineRunner
    constructs one internally per tool call, so tests monkeypatch the class
    itself (pipeline.runner.EscalationController) rather than injecting an
    instance. `outcome_factory` lets each test control merged/reason without
    a real HTTP call or a live Next.js endpoint."""

    _outcome_factory = None  # set by each test via monkeypatch before use

    def __init__(self, *, agent_id, call_uuid, speak, client=None):
        self.agent_id = agent_id
        self.call_uuid = call_uuid
        self.speak = speak

    _callback_calls: list = None  # class-level list a test can inspect after the fact

    async def request_handoff(self, reason: str):
        outcome = FakeEscalationController._outcome_factory(reason)
        if not outcome.merged:
            await self.speak("Sorry, I couldn't reach anyone right now.")
        return outcome

    async def request_callback(self, reason: str):
        from escalation import CallbackOutcome

        if FakeEscalationController._callback_calls is not None:
            FakeEscalationController._callback_calls.append(reason)
        await self.speak("Done - someone will call you back soon.")
        return CallbackOutcome(created=True, task_id="task-1")


@pytest.mark.asyncio
async def test_collect_utterance_ends_on_trailing_silence():
    config = _cascade_config()
    player = FakePlayer()
    speaking = {"value": False}
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: speaking.__setitem__("value", v)),
        transcript=[],
        set_bot_speaking=lambda v: speaking.__setitem__("value", v),
    )
    runner.push_audio(_voiced_frame())
    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())

    utterance = await runner._collect_utterance()
    assert utterance is not None
    assert len(utterance) == 27  # 2 voiced + 25 trailing silent


@pytest.mark.asyncio
async def test_collect_utterance_drops_leading_silence():
    config = _cascade_config()
    player = FakePlayer()
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    for _ in range(10):
        runner.push_audio(_silent_frame())
    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())

    utterance = await runner._collect_utterance()
    assert utterance is not None
    assert len(utterance) == 26  # leading silence dropped: 1 voiced + 25 trailing


@pytest.mark.asyncio
async def test_collect_utterance_returns_none_on_close():
    config = _cascade_config()
    player = FakePlayer()
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    await runner.stop()
    assert await runner._collect_utterance() is None


@pytest.mark.asyncio
async def test_cascade_end_to_end_drives_stt_llm_tts(monkeypatch):
    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_llm", lambda cfg: FakeLlm(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))

    config = _cascade_config(greeting="Hello there")
    player = FakePlayer()
    transcript = []
    speaking = {"value": False}
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: speaking.__setitem__("value", v)),
        transcript=transcript,
        set_bot_speaking=lambda v: speaking.__setitem__("value", v),
    )
    runner.start()

    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())

    await runner.stop()

    assert player.enqueued[0] == b"audio:Hello there"
    assert b"audio:ok, thanks" in player.enqueued
    roles_texts = [(t.role, t.text) for t in transcript]
    assert ("agent", "Hello there") in roles_texts
    assert ("caller", "heard 26 frames") in roles_texts
    assert ("agent", "ok, thanks") in roles_texts
    assert speaking["value"] is False


@pytest.mark.asyncio
async def test_cascade_tool_call_merges_and_ends_the_turn_loop(monkeypatch):
    from escalation import EscalationOutcome

    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_llm", lambda cfg: FakeLlmEscalates(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))
    FakeEscalationController._outcome_factory = lambda reason: EscalationOutcome(
        merged=True, target_label="+971500000000", human_answered=None
    )
    monkeypatch.setattr("pipeline.runner.EscalationController", FakeEscalationController)

    config = _cascade_config()
    player = FakePlayer()
    transcript = []
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=transcript,
        set_bot_speaking=lambda v: None,
        call_uuid="call-1",
    )
    runner.start()

    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())

    await runner.stop()

    assert runner.escalation_request is not None
    assert runner.escalation_request.name == "request_human_handoff"
    assert runner.escalation_request.arguments == {"reason": "caller asked"}
    assert runner.escalation_outcome is not None
    assert runner.escalation_outcome.merged is True
    assert runner.escalation_outcome.target_label == "+971500000000"
    # The tool call must never be spoken as if it were a normal reply.
    assert not any(b"tool_call" in chunk or b"ToolCall" in chunk for chunk in player.enqueued)
    assert all(not text.strip().startswith("ok") for role, text in ((t.role, t.text) for t in transcript))


@pytest.mark.asyncio
async def test_cascade_tool_call_blocked_clears_state_and_keeps_talking(monkeypatch):
    from escalation import EscalationOutcome

    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_llm", lambda cfg: FakeLlmEscalatesThenTalks(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))
    FakeEscalationController._outcome_factory = lambda reason: EscalationOutcome(merged=False, reason="gsm_capacity")
    monkeypatch.setattr("pipeline.runner.EscalationController", FakeEscalationController)

    config = _cascade_config()
    player = FakePlayer()
    transcript = []
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=transcript,
        set_bot_speaking=lambda v: None,
        call_uuid="call-1",
    )
    runner.start()

    # First utterance triggers the (blocked) escalation attempt.
    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())
    # A second utterance should be handled normally afterward - the loop
    # must NOT have ended just because the first attempt didn't merge.
    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())

    await runner.stop()

    # Cleared after a non-merge, so a later attempt is possible and a stale
    # "escalation in progress" state doesn't linger.
    assert runner.escalation_request is None
    assert runner.escalation_outcome is None
    roles_texts = [(t.role, t.text) for t in transcript]
    assert ("agent", "Sorry, I couldn't reach anyone right now.") in roles_texts
    # The conversation continued past the blocked attempt.
    assert ("agent", "sure, no problem") in roles_texts


def test_escalation_tools_empty_without_a_handoff_target():
    runner = PipelineRunner(
        config=_cascade_config(handoff_extension_hint=None),
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    assert runner._escalation_tools() == []


def test_escalation_tools_offered_when_a_handoff_target_is_configured():
    runner = PipelineRunner(
        config=_cascade_config(handoff_extension_hint="+971500000000"),
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    tools = runner._escalation_tools()
    assert len(tools) == 1
    assert tools[0].name == "request_human_handoff"


def test_escalation_tools_adds_callback_only_after_a_failed_handoff():
    runner = PipelineRunner(
        config=_cascade_config(handoff_extension_hint="+971500000000"),
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    assert [t.name for t in runner._escalation_tools()] == ["request_human_handoff"]

    runner.handoff_failed_once = True
    assert [t.name for t in runner._escalation_tools()] == ["request_human_handoff", "request_callback"]


@pytest.mark.asyncio
async def test_cascade_offers_and_drives_callback_after_a_failed_handoff(monkeypatch):
    from escalation import EscalationOutcome

    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_llm", lambda cfg: FakeLlmEscalatesThenRequestsCallback(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))
    FakeEscalationController._outcome_factory = lambda reason: EscalationOutcome(merged=False, reason="gsm_capacity")
    FakeEscalationController._callback_calls = []
    monkeypatch.setattr("pipeline.runner.EscalationController", FakeEscalationController)

    config = _cascade_config(handoff_extension_hint="+971500000000")
    player = FakePlayer()
    transcript = []
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=transcript,
        set_bot_speaking=lambda v: None,
        call_uuid="call-1",
    )
    runner.start()

    # First utterance: the (blocked) handoff attempt.
    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())
    # Second utterance: caller agrees to a callback.
    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())

    await runner.stop()

    assert runner.handoff_failed_once is True
    assert FakeEscalationController._callback_calls == ["billing question"]
    roles_texts = [(t.role, t.text) for t in transcript]
    assert ("agent", "Done - someone will call you back soon.") in roles_texts
