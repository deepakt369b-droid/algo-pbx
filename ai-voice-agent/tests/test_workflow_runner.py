import struct

import pytest

from config_client import AiAgentConfig, LegConfig
from pipeline.base import LlmDelta, ToolCall
from pipeline.runner import PipelineRunner, PlayerAudioSink, VOICE_ENERGY_THRESHOLD


def _silent_frame() -> bytes:
    return struct.pack("<160h", *([0] * 160))


def _voiced_frame() -> bytes:
    sample = int(32767 * (VOICE_ENERGY_THRESHOLD + 0.2))
    return struct.pack("<160h", *([sample] * 160))


def _node(id_, kind, **overrides):
    base = {
        "id": id_,
        "kind": kind,
        "label": id_,
        "prompt": "",
        "allowInterruption": True,
        "variables": [],
        "modelOverride": {},
    }
    base.update(overrides)
    return base


def _edge(id_, source, target, condition):
    return {"id": id_, "source": source, "target": target, "condition": condition}


def _workflow_config(graph, **overrides) -> AiAgentConfig:
    leg = LegConfig(provider="deepgram", model="nova-2", api_key="k")
    base = dict(
        agent_id="agent-1",
        extension_number="500",
        language="en",
        greeting="Hello there",
        system_prompt="You are a helpful agent.",
        pipeline_mode="CASCADE",
        stt=leg,
        llm=leg,
        tts=leg,
        prompt_mode="WORKFLOW",
        workflow={"version": 1, "graph": graph, "resolvedByNodeId": {}},
    )
    base.update(overrides)
    return AiAgentConfig(**base)


class FakePlayer:
    def __init__(self):
        self.enqueued: list[bytes] = []

    def enqueue(self, payload: bytes) -> None:
        self.enqueued.append(payload)

    def flush(self) -> None:
        pass


class FakeStt:
    def __init__(self, config):
        pass

    async def transcribe_stream(self, audio_chunks) -> str:
        _ = [c async for c in audio_chunks]
        return "hello"


class FakeTts:
    def __init__(self, config):
        pass

    async def synthesize(self, text: str):
        yield f"audio:{text}".encode()


def _push_one_utterance(runner: PipelineRunner) -> None:
    runner.push_audio(_voiced_frame())
    for _ in range(25):
        runner.push_audio(_silent_frame())


class ScriptedWorkflowLlm:
    """A fake LLM whose behavior is driven by a list of "turn scripts" - one
    entry consumed per llm.generate() call (i.e. per round). Each script
    entry is one of:
      - {"text": "..."} -> yields that text, no tool call
      - {"record": {...}} -> emits a record_info tool call with those args
      - {"goto": "<condition substring>"} -> finds the first offered tool
        whose description matches the substring and calls it (robust
        against pathway tool names' generated id suffixes)
      - {"escalate": True} -> emits a request_human_handoff tool call
    """

    def __init__(self, config):
        self.calls = 0
        self.script: list[dict] = []
        self.seen_tools: list[list] = []

    async def generate(self, messages, tools=None):
        self.seen_tools.append(tools or [])
        entry = self.script[self.calls] if self.calls < len(self.script) else {"text": ""}
        self.calls += 1
        if "text" in entry:
            yield LlmDelta(text=entry["text"])
            return
        if "record" in entry:
            yield LlmDelta(tool_call=ToolCall(name="record_info", arguments=entry["record"], call_id=f"c{self.calls}"))
            return
        if "goto" in entry:
            match = next((t for t in (tools or []) if entry["goto"] in t.description), None)
            assert match is not None, f"no offered tool matched condition substring {entry['goto']!r}"
            yield LlmDelta(tool_call=ToolCall(name=match.name, arguments={}, call_id=f"c{self.calls}"))
            return
        if entry.get("escalate"):
            yield LlmDelta(tool_call=ToolCall(name="request_human_handoff", arguments={"reason": "caller asked"}))
            return


@pytest.mark.asyncio
async def test_linear_graph_speaks_start_and_end_prompts(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node("end", "END_CALL", prompt="Goodbye!"),
        ],
        "edges": [_edge("e1", "start", "end", "always")],
    }
    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))

    config = _workflow_config(graph)
    player = FakePlayer()
    transcript = []
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=transcript,
        set_bot_speaking=lambda v: None,
    )
    runner.start()
    await runner.stop()

    assert b"audio:Hello there" in player.enqueued  # START_CALL has no prompt -> falls back to agent greeting
    assert b"audio:Goodbye!" in player.enqueued
    assert runner.node_path == ["start", "end"]


@pytest.mark.asyncio
async def test_agent_node_collects_variable_and_transitions_on_goto(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node(
                "ask",
                "AGENT",
                prompt="Ask the caller's name.",
                variables=[{"name": "caller_name", "type": "string", "prompt": "extract the name"}],
            ),
            _node("end", "END_CALL", prompt="Bye, {{gathered_context.caller_name}}!"),
        ],
        "edges": [
            _edge("e1", "start", "ask", "always"),
            _edge("e2", "ask", "end", "caller gave their name"),
        ],
    }
    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))
    fake_llm = ScriptedWorkflowLlm(None)
    fake_llm.script = [
        {"record": {"caller_name": "Sam"}},
        {"goto": "caller gave their name"},
    ]
    monkeypatch.setattr("pipeline.runner.build_llm", lambda cfg: fake_llm)

    config = _workflow_config(graph, greeting="")
    player = FakePlayer()
    transcript = []
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=transcript,
        set_bot_speaking=lambda v: None,
    )
    runner.start()
    _push_one_utterance(runner)
    await runner.stop()

    assert runner.gathered_context == {"caller_name": "Sam"}
    assert runner.node_path == ["start", "ask", "end"]
    assert b"audio:Bye, Sam!" in player.enqueued


@pytest.mark.asyncio
async def test_agent_node_speaks_plain_reply_and_stays_on_same_node(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node("ask", "AGENT", prompt="Chat."),
            _node("end", "END_CALL", prompt="Bye"),
        ],
        "edges": [_edge("e1", "start", "ask", "always"), _edge("e2", "ask", "end", "done")],
    }
    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))
    fake_llm = ScriptedWorkflowLlm(None)
    fake_llm.script = [{"text": "Sure, tell me more."}]
    monkeypatch.setattr("pipeline.runner.build_llm", lambda cfg: fake_llm)

    config = _workflow_config(graph, greeting="")
    player = FakePlayer()
    transcript = []
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=transcript,
        set_bot_speaking=lambda v: None,
    )
    runner.start()
    _push_one_utterance(runner)
    await runner.stop()

    assert b"audio:Sure, tell me more." in player.enqueued
    assert runner.node_path == ["start", "ask"]  # never moved off "ask"


@pytest.mark.asyncio
async def test_http_tool_node_runs_automatically_and_merges_extracted_context(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node("lookup", "HTTP_TOOL", label="Order lookup", urlTemplate="https://api.example.com/x"),
            _node("end", "END_CALL", prompt="Your order status is {{gathered_context.status}}."),
        ],
        "edges": [_edge("e1", "start", "lookup", "always"), _edge("e2", "lookup", "end", "always")],
    }
    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))

    config = _workflow_config(graph, greeting="")
    player = FakePlayer()
    transcript = []
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=transcript,
        set_bot_speaking=lambda v: None,
    )

    class FakeHttpToolClient:
        async def call(self, *, agent_id, node_id, gathered_context=None):
            assert node_id == "lookup"
            return {"ok": True, "extracted": {"status": "shipped"}}

    runner.http_tool_client = FakeHttpToolClient()
    runner.start()
    await runner.stop()

    assert runner.gathered_context == {"status": "shipped"}
    assert runner.node_path == ["start", "lookup", "end"]
    assert b"audio:Your order status is shipped." in player.enqueued


@pytest.mark.asyncio
async def test_http_tool_node_failure_still_advances_gracefully(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node("lookup", "HTTP_TOOL", label="Order lookup", urlTemplate="https://api.example.com/x"),
            _node("end", "END_CALL", prompt="Sorry, something went wrong."),
        ],
        "edges": [_edge("e1", "start", "lookup", "always"), _edge("e2", "lookup", "end", "always")],
    }
    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))

    config = _workflow_config(graph, greeting="")
    player = FakePlayer()
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )

    from http_tool_client import HttpToolRequestError

    class FailingHttpToolClient:
        async def call(self, *, agent_id, node_id, gathered_context=None):
            raise HttpToolRequestError("boom")

    runner.http_tool_client = FailingHttpToolClient()
    runner.start()
    await runner.stop()

    assert runner.gathered_context == {}
    assert b"audio:Sorry, something went wrong." in player.enqueued


@pytest.mark.asyncio
async def test_transfer_node_invokes_escalation_controller(monkeypatch):
    from escalation import EscalationOutcome

    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node("ask", "AGENT", prompt="Ask."),
            _node("xfer", "TRANSFER", transferTargetKind="NUMBER", transferNumberE164="+971500000000"),
        ],
        "edges": [_edge("e1", "start", "ask", "always"), _edge("e2", "ask", "xfer", "needs human")],
    }
    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))
    fake_llm = ScriptedWorkflowLlm(None)
    fake_llm.script = [{"goto": "needs human"}]
    monkeypatch.setattr("pipeline.runner.build_llm", lambda cfg: fake_llm)

    class FakeEscalationController:
        def __init__(self, *, agent_id, call_uuid, speak, client=None):
            self.speak = speak

        async def request_handoff(self, reason: str):
            await self.speak("One moment.")
            return EscalationOutcome(merged=True, target_label="+971500000000", human_answered=None)

    monkeypatch.setattr("pipeline.runner.EscalationController", FakeEscalationController)

    config = _workflow_config(graph, greeting="")
    transcript = []
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=transcript,
        set_bot_speaking=lambda v: None,
        call_uuid="call-1",
    )
    runner.start()
    _push_one_utterance(runner)
    await runner.stop()

    assert runner.node_path == ["start", "ask", "xfer"]
    assert runner.escalation_outcome is not None
    assert runner.escalation_outcome.merged is True


class FakeRealtimeProvider:
    """Stand-in for OpenAiRealtime - records every send_tool_result/
    update_session call and, when given a `script` of ToolCalls, invokes
    on_tool_call for each in order before returning (simulating the vendor
    session calling tools one after another)."""

    def __init__(self, config, system_prompt=""):
        self.config = config
        self.system_prompt = system_prompt
        self.sent_results: list[tuple] = []
        self.session_updates: list[tuple] = []
        self.script: list[ToolCall] = []
        self.initial_tools = None

    async def run(self, audio_in, audio_out, *, tools=None, on_tool_call=None):
        self.initial_tools = tools
        for tc in self.script:
            await on_tool_call(tc)

    async def send_tool_result(self, call_id, name, result):
        self.sent_results.append((call_id, name, result))

    async def update_session(self, instructions, tools):
        self.session_updates.append((instructions, tools))


def _realtime_workflow_config(graph, **overrides) -> AiAgentConfig:
    realtime_leg = LegConfig(provider="openai", model="gpt-4o-realtime-preview", api_key="k")
    base = dict(
        agent_id="agent-1",
        extension_number="500",
        language="en",
        greeting="",
        system_prompt="You are a helpful agent.",
        pipeline_mode="REALTIME",
        realtime=realtime_leg,
        prompt_mode="WORKFLOW",
        workflow={"version": 1, "graph": graph, "resolvedByNodeId": {}},
    )
    base.update(overrides)
    return AiAgentConfig(**base)


@pytest.mark.asyncio
async def test_realtime_workflow_starts_session_with_first_node_instructions_and_tools(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node("ask", "AGENT", prompt="Ask their name."),
            _node("end", "END_CALL", prompt="Bye"),
        ],
        "edges": [_edge("e1", "start", "ask", "always"), _edge("e2", "ask", "end", "caller is done")],
    }
    fake_provider = FakeRealtimeProvider(None)
    monkeypatch.setattr("pipeline.runner.build_realtime", lambda cfg, system_prompt="": fake_provider)

    config = _realtime_workflow_config(graph)
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    runner.start()
    await runner.stop()

    assert "Ask their name." in fake_provider.system_prompt
    assert any(t.name.startswith("goto_") for t in fake_provider.initial_tools)
    assert runner.node_path == ["start", "ask"]


@pytest.mark.asyncio
async def test_realtime_workflow_goto_sends_result_and_updates_session(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node("ask", "AGENT", prompt="Ask their name."),
            _node("confirm", "AGENT", prompt="Confirm the order."),
        ],
        "edges": [
            _edge("e1", "start", "ask", "always"),
            _edge("e2", "ask", "confirm", "caller gave their name"),
        ],
    }
    fake_provider = FakeRealtimeProvider(None)
    monkeypatch.setattr("pipeline.runner.build_realtime", lambda cfg, system_prompt="": fake_provider)

    config = _realtime_workflow_config(graph)
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )

    async def fake_run(audio_in, audio_out, *, tools=None, on_tool_call=None):
        fake_provider.initial_tools = tools
        goto_tool = next(t for t in tools if t.name.startswith("goto_"))
        await on_tool_call(ToolCall(name=goto_tool.name, arguments={}, call_id="c1"))

    fake_provider.run = fake_run
    runner.start()
    await runner.stop()

    assert fake_provider.sent_results == [("c1", fake_provider.sent_results[0][1], {"ok": True, "moved_to": "confirm"})]
    assert len(fake_provider.session_updates) == 1
    instructions, tools = fake_provider.session_updates[0]
    assert "Confirm the order." in instructions
    assert runner.node_path == ["start", "ask", "confirm"]


@pytest.mark.asyncio
async def test_realtime_workflow_record_info_updates_gathered_context_without_moving(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node(
                "ask",
                "AGENT",
                prompt="Ask their name.",
                variables=[{"name": "caller_name", "type": "string", "prompt": "the name"}],
            ),
        ],
        "edges": [_edge("e1", "start", "ask", "always")],
    }
    fake_provider = FakeRealtimeProvider(None)

    async def fake_run(audio_in, audio_out, *, tools=None, on_tool_call=None):
        fake_provider.initial_tools = tools
        await on_tool_call(ToolCall(name="record_info", arguments={"caller_name": "Sam"}, call_id="c1"))

    fake_provider.run = fake_run
    monkeypatch.setattr("pipeline.runner.build_realtime", lambda cfg, system_prompt="": fake_provider)

    config = _realtime_workflow_config(graph)
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    runner.start()
    await runner.stop()

    assert runner.gathered_context == {"caller_name": "Sam"}
    assert fake_provider.sent_results == [("c1", "record_info", {"ok": True})]
    assert fake_provider.session_updates == []  # no node transition happened
    assert runner.node_path == ["start", "ask"]


@pytest.mark.asyncio
async def test_realtime_workflow_goto_to_end_call_tells_session_to_say_goodbye(monkeypatch):
    graph = {
        "nodes": [
            _node("start", "START_CALL"),
            _node("ask", "AGENT", prompt="Ask."),
            _node("end", "END_CALL", prompt="Thanks, goodbye!"),
        ],
        "edges": [_edge("e1", "start", "ask", "always"), _edge("e2", "ask", "end", "done")],
    }
    fake_provider = FakeRealtimeProvider(None)

    async def fake_run(audio_in, audio_out, *, tools=None, on_tool_call=None):
        fake_provider.initial_tools = tools
        goto_tool = next(t for t in tools if t.name.startswith("goto_"))
        await on_tool_call(ToolCall(name=goto_tool.name, arguments={}, call_id="c1"))

    fake_provider.run = fake_run
    monkeypatch.setattr("pipeline.runner.build_realtime", lambda cfg, system_prompt="": fake_provider)

    config = _realtime_workflow_config(graph)
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    runner.start()
    await runner.stop()

    assert len(fake_provider.session_updates) == 1
    instructions, tools = fake_provider.session_updates[0]
    assert instructions == "Thanks, goodbye!"
    assert tools == []
    assert runner.node_path == ["start", "ask", "end"]


@pytest.mark.asyncio
async def test_realtime_workflow_falls_back_to_plain_realtime_for_gemini_provider(monkeypatch):
    graph = {"nodes": [_node("start", "START_CALL"), _node("end", "END_CALL")], "edges": [_edge("e1", "start", "end", "always")]}

    called = {"plain_realtime": False}

    async def fake_run_realtime(self):
        called["plain_realtime"] = True

    monkeypatch.setattr(PipelineRunner, "_run_realtime", fake_run_realtime)

    realtime_leg = LegConfig(provider="gemini", model="gemini-live", api_key="k")
    config = _realtime_workflow_config(graph, realtime=realtime_leg)
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(FakePlayer(), lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    runner.start()
    await runner.stop()

    assert called["plain_realtime"] is True


@pytest.mark.asyncio
async def test_unparseable_graph_falls_back_to_simple_cascade(monkeypatch):
    monkeypatch.setattr("pipeline.runner.build_stt", lambda cfg: FakeStt(cfg))
    monkeypatch.setattr("pipeline.runner.build_tts", lambda cfg: FakeTts(cfg))

    class FallbackLlm:
        def __init__(self, config):
            pass

        async def generate(self, messages, tools=None):
            yield LlmDelta(text="fallback reply")

    monkeypatch.setattr("pipeline.runner.build_llm", lambda cfg: FallbackLlm(cfg))

    config = _workflow_config({"nodes": [{"id": "x"}], "edges": []}, greeting="Hi")  # missing required "kind" field
    player = FakePlayer()
    runner = PipelineRunner(
        config=config,
        audio_sink=PlayerAudioSink(player, lambda v: None),
        transcript=[],
        set_bot_speaking=lambda v: None,
    )
    runner.start()
    _push_one_utterance(runner)
    await runner.stop()

    assert b"audio:Hi" in player.enqueued
    assert b"audio:fallback reply" in player.enqueued
    assert runner.node_path == []  # never entered the workflow interpreter at all
