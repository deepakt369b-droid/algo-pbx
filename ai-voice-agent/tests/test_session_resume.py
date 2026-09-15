"""Integration-style tests for main.py's AI -> human escalation session
continuity (LLM.md §34.2's plan, Workstream B): a resumed conference leg
must reuse the original call's config/transcript, and reporting must happen
exactly once, under the ORIGINAL call_uuid, regardless of which leg (the
original or the resumed one) actually calls SessionReporter.report().

Drives AudioSocketServer._handle_connection directly against fake
reader/writer objects rather than a real socket - PipelineRunner is
monkeypatched to a bookkeeping fake so these tests exercise main.py's own
orchestration (LiveSession creation/lookup/ready_event/reporting), not the
pipeline internals covered elsewhere.
"""

from __future__ import annotations

import asyncio
import uuid as uuid_module

import pytest

import main
from audiosocket.protocol import FrameType, encode_frame
from config_client import AiAgentConfig, LegConfig
from escalation import EscalationOutcome
from main import AudioSocketServer, PendingCall
from session_reporter import TranscriptTurn


class FakeReader:
    """A StreamReader stand-in whose `read()` blocks until the test feeds a
    chunk - lets a test control exactly when each connection observes the
    next byte, which is what makes the cross-connection ordering in
    test_original_leg_migration_skips_its_own_report deterministic."""

    def __init__(self) -> None:
        self._queue: "asyncio.Queue[bytes]" = asyncio.Queue()

    def feed(self, data: bytes) -> None:
        self._queue.put_nowait(data)

    def feed_eof(self) -> None:
        self._queue.put_nowait(b"")

    async def read(self, _n: int) -> bytes:
        return await self._queue.get()


class FakeWriter:
    def __init__(self) -> None:
        self.written = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        self.written.extend(data)

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True

    def get_extra_info(self, _name: str):
        return ("127.0.0.1", 0)


class FakePipelineRunner:
    """Bookkeeping stand-in for pipeline.runner.PipelineRunner - records the
    constructor kwargs main.py passed it (so tests can assert
    resume_context/skip_greeting/call_uuid) and lets a test set
    escalation_request/escalation_outcome directly, simulating "by the time
    this connection tears down, the pipeline had already recorded this
    outcome" without driving any real audio through a real provider."""

    instances: list["FakePipelineRunner"] = []

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.escalation_request = None
        self.escalation_outcome = None
        self.gathered_context: dict = {}
        self.node_path: list = []
        FakePipelineRunner.instances.append(self)

    def start(self) -> None:
        pass

    def push_audio(self, _chunk: bytes) -> None:
        pass

    async def stop(self) -> None:
        pass


class FakeConfigClient:
    def __init__(self, config: AiAgentConfig) -> None:
        self._config = config
        self.fetch_calls = 0

    async def fetch(self, *, extension: str, tenant_id: str) -> AiAgentConfig:
        self.fetch_calls += 1
        return self._config


class FakeSessionReporter:
    def __init__(self) -> None:
        self.reports: list = []

    async def report(self, report) -> None:
        self.reports.append(report)


def _uuid_frame(call_uuid: str) -> bytes:
    return encode_frame(FrameType.UUID, uuid_module.UUID(call_uuid).bytes)


def _config() -> AiAgentConfig:
    leg = LegConfig(provider="deepgram", model="nova-2", api_key="k")
    return AiAgentConfig(
        agent_id="agent-1",
        extension_number="500",
        language="en",
        greeting="Hello!",
        system_prompt="Be terse.",
        pipeline_mode="CASCADE",
        stt=leg,
        llm=leg,
        tts=leg,
        handoff_extension_hint="+971501234567",
    )


@pytest.fixture(autouse=True)
def _patch_pipeline_runner(monkeypatch):
    FakePipelineRunner.instances = []
    monkeypatch.setattr(main, "PipelineRunner", FakePipelineRunner)
    yield


@pytest.mark.asyncio
async def test_normal_call_creates_and_cleans_up_its_own_session():
    config_client = FakeConfigClient(_config())
    reporter = FakeSessionReporter()
    server = AudioSocketServer({}, config_client, reporter)

    original_uuid = str(uuid_module.uuid4())
    server._registry[original_uuid] = PendingCall(call_uuid=original_uuid, extension="500", tenant_id="t1")

    reader, writer = FakeReader(), FakeWriter()
    reader.feed(_uuid_frame(original_uuid))
    reader.feed_eof()
    await server._handle_connection(reader, writer)

    assert config_client.fetch_calls == 1
    assert len(reporter.reports) == 1
    assert reporter.reports[0].cdr_unique_id == original_uuid
    assert reporter.reports[0].outcome == "completed"
    # No LiveSession left behind once a non-escalated call finishes.
    assert original_uuid not in server._sessions


@pytest.mark.asyncio
async def test_original_leg_migration_skips_its_own_report_and_resumed_leg_reports_once():
    config = _config()
    config_client = FakeConfigClient(config)
    reporter = FakeSessionReporter()
    server = AudioSocketServer({}, config_client, reporter)

    original_uuid = str(uuid_module.uuid4())
    conf_leg_uuid = str(uuid_module.uuid4())
    server._registry[original_uuid] = PendingCall(call_uuid=original_uuid, extension="500", tenant_id="t1")

    original_reader, original_writer = FakeReader(), FakeWriter()
    original_task = asyncio.create_task(server._handle_connection(original_reader, original_writer))

    original_reader.feed(_uuid_frame(original_uuid))
    # Let the original connection's UUID-frame handling run to completion
    # (fetch config, create the LiveSession, construct+start its runner)
    # before feeding EOF - otherwise the two could interleave arbitrarily.
    for _ in range(20):
        await asyncio.sleep(0)

    assert original_uuid in server._sessions
    original_runner = FakePipelineRunner.instances[-1]
    # Simulate: this connection's pipeline recorded a successful merge
    # before the caller was AMI-Redirected out of it.
    original_runner.escalation_outcome = EscalationOutcome(merged=True, target_label="+971501234567", human_answered=True)

    # Now the conference leg registers and connects - resume_of points back
    # at the original call. Its own UUID-frame handling will set
    # migrated_to and then block on ready_event (not yet set).
    server._registry[conf_leg_uuid] = PendingCall(
        call_uuid=conf_leg_uuid, extension="500", tenant_id="t1", resume_of=original_uuid, role="conference"
    )
    resumed_reader, resumed_writer = FakeReader(), FakeWriter()
    resumed_task = asyncio.create_task(server._handle_connection(resumed_reader, resumed_writer))
    resumed_reader.feed(_uuid_frame(conf_leg_uuid))
    for _ in range(20):
        await asyncio.sleep(0)

    # The resumed leg must be genuinely blocked on ready_event right now -
    # confirmed by it NOT having constructed its runner yet.
    assert len(FakePipelineRunner.instances) == 1
    assert server._sessions[original_uuid].migrated_to == conf_leg_uuid

    # Now the original leg's AudioSocket connection tears down (the AMI
    # Redirect interrupting it) - EOF.
    original_reader.feed_eof()
    await original_task

    # The original leg must NOT have reported - the resumed leg owns that.
    assert len(reporter.reports) == 0
    # But config_client.fetch was only ever called once (by the original
    # leg) - the resumed leg must skip it entirely.
    assert config_client.fetch_calls == 1

    # ready_event is now set; the resumed leg's wait unblocks and it builds
    # its own runner.
    for _ in range(20):
        await asyncio.sleep(0)
    assert len(FakePipelineRunner.instances) == 2
    resumed_runner = FakePipelineRunner.instances[-1]
    assert resumed_runner.kwargs["resume_context"] is not None
    assert resumed_runner.kwargs["skip_greeting"] is True
    assert resumed_runner.kwargs["call_uuid"] == conf_leg_uuid
    # Reuses the EXACT SAME config object and transcript list - never
    # re-fetched, per the plan's "skip config_client.fetch() entirely".
    assert resumed_runner.kwargs["config"] is config

    resumed_reader.feed_eof()
    await resumed_task

    # Exactly one report, under the ORIGINAL uuid, marked handed_off.
    assert len(reporter.reports) == 1
    report = reporter.reports[0]
    assert report.cdr_unique_id == original_uuid
    assert report.outcome == "handed_off"
    assert report.handoff_extension_id == "+971501234567"
    # Both legs' sessions are cleaned up.
    assert original_uuid not in server._sessions


@pytest.mark.asyncio
async def test_resume_of_with_no_matching_session_falls_back_to_a_fresh_fetch():
    config_client = FakeConfigClient(_config())
    reporter = FakeSessionReporter()
    server = AudioSocketServer({}, config_client, reporter)

    call_uuid = str(uuid_module.uuid4())
    server._registry[call_uuid] = PendingCall(
        call_uuid=call_uuid, extension="500", tenant_id="t1", resume_of="nonexistent-uuid", role="conference"
    )

    reader, writer = FakeReader(), FakeWriter()
    reader.feed(_uuid_frame(call_uuid))
    reader.feed_eof()
    await server._handle_connection(reader, writer)

    assert config_client.fetch_calls == 1
    assert len(reporter.reports) == 1
    assert reporter.reports[0].outcome == "completed"


@pytest.mark.asyncio
async def test_shared_transcript_list_reused_by_resumed_leg(monkeypatch):
    """The plan's own invariant: the resumed leg must append to the SAME
    transcript list object the original leg was writing to, so the final
    report carries the whole conversation, not just the post-merge half."""
    config = _config()
    config_client = FakeConfigClient(config)
    reporter = FakeSessionReporter()
    server = AudioSocketServer({}, config_client, reporter)

    original_uuid = str(uuid_module.uuid4())
    conf_leg_uuid = str(uuid_module.uuid4())
    server._registry[original_uuid] = PendingCall(call_uuid=original_uuid, extension="500", tenant_id="t1")

    original_reader, original_writer = FakeReader(), FakeWriter()
    original_task = asyncio.create_task(server._handle_connection(original_reader, original_writer))
    original_reader.feed(_uuid_frame(original_uuid))
    for _ in range(20):
        await asyncio.sleep(0)

    live_session = server._sessions[original_uuid]
    live_session.transcript.append(TranscriptTurn(role="caller", text="I want a human"))

    server._registry[conf_leg_uuid] = PendingCall(
        call_uuid=conf_leg_uuid, extension="500", tenant_id="t1", resume_of=original_uuid, role="conference"
    )
    resumed_reader, resumed_writer = FakeReader(), FakeWriter()
    resumed_task = asyncio.create_task(server._handle_connection(resumed_reader, resumed_writer))
    resumed_reader.feed(_uuid_frame(conf_leg_uuid))
    for _ in range(20):
        await asyncio.sleep(0)

    resumed_runner = FakePipelineRunner.instances[-1]
    assert resumed_runner.kwargs["transcript"] is live_session.transcript
    assert any(t.text == "I want a human" for t in resumed_runner.kwargs["transcript"])

    original_reader.feed_eof()
    await original_task
    resumed_reader.feed_eof()
    await resumed_task
