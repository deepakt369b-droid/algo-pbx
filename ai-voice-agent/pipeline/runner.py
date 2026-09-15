"""Per-call pipeline runner: drives either the REALTIME provider or the
STT -> LLM -> TTS cascade against the raw AudioSocket audio stream, feeding
transcript turns back to the caller for session reporting.

This closes the gap main.py's module docstring used to flag: the AudioSocket
connection handler owns framing/barge-in/pre-registration, and hands every
inbound SLIN frame to a `PipelineRunner` here, which owns actually driving a
provider per `config.pipeline_mode` and pushing synthesized audio back out
through the connection's `PacedPlayer` via the narrow `OutgoingAudioSink`
Protocol (see pipeline/base.py) - the pipeline never touches AudioSocket
framing directly.

KNOWN LIMITATION, not glossed over: while the cascade is mid-turn (STT
running, or an LLM/TTS network call in flight), inbound caller audio keeps
queuing rather than being dropped or interrupting that turn - there is no
mid-turn cancellation on barge-in for the cascade path, only the existing
BargeInDetector's flush of already-*enqueued* outbound audio in main.py.
Queued caller audio from that window is simply included in the next
utterance's STT input. Full barge-in-cancels-in-flight-turn semantics is a
follow-up, not attempted here.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator, Callable, Optional
from uuid import uuid4

from audiosocket.protocol import frame_energy
from config_client import AiAgentConfig, LegConfig
from escalation import EscalationController, EscalationOutcome
from http_tool_client import HttpToolClient, HttpToolRequestError
from session_reporter import TranscriptTurn

from .base import ChatMessage, OutgoingAudioSink, ProviderLegConfig, ToolCall, ToolSpec
from .registry import build_llm, build_realtime, build_stt, build_tts
from .tools import REQUEST_CALLBACK, REQUEST_CALLBACK_TOOL, REQUEST_HUMAN_HANDOFF, REQUEST_HUMAN_HANDOFF_TOOL
from .workflow import (
    RECORD_INFO_TOOL_NAME,
    WorkflowGraph,
    WorkflowNode,
    WorkflowParseError,
    extraction_tool,
    pathway_tool_map,
    pathway_tools,
    render,
    system_prompt_for,
)

logger = logging.getLogger("ai-voice-agent.pipeline")

# Consecutive silent 20ms frames (audiosocket/protocol.py's FRAME_MS) after
# speech has been observed before an utterance is considered finished and
# handed to STT. 25 * 20ms = 500ms - a conventional phone-bot endpointing
# gap: long enough not to clip mid-sentence pauses, short enough to feel
# responsive.
END_OF_UTTERANCE_SILENT_FRAMES = 25
VOICE_ENERGY_THRESHOLD = 0.08


def _leg_config(leg: LegConfig) -> ProviderLegConfig:
    return ProviderLegConfig(
        provider=leg.provider,
        model=leg.model,
        api_key=leg.api_key,
        voice=leg.voice,
        region=leg.region,
        base_url=leg.base_url,
        extra=dict(leg.extra),
    )


def _resolved_leg_config(resolved: dict, *, leg_kind: str) -> ProviderLegConfig:
    """Builds a ProviderLegConfig from one entry of
    workflow.resolvedByNodeId[nodeId]["llm"|"tts"] - already-decrypted,
    camelCase JSON straight off the wire (see agent-config/route.ts's
    resolveWorkflowRuntime()). `extra` carries the same
    temperature/max_tokens/speed knobs the top-level legs use, so a node
    override reaches the exact same provider code path as the agent's own
    default leg (openai_compatible.py's _body(), etc.) - no separate
    "workflow leg" code path was written in any provider module."""
    extra: dict = {}
    if resolved.get("temperature") is not None:
        extra["temperature"] = resolved["temperature"]
    if resolved.get("maxTokens") is not None:
        extra["max_tokens"] = resolved["maxTokens"]
    if leg_kind == "tts" and resolved.get("speed") is not None:
        extra["speed"] = resolved["speed"]
    return ProviderLegConfig(
        provider=resolved["provider"],
        model=resolved["model"],
        api_key=resolved["apiKey"],
        voice=resolved.get("voice"),
        region=resolved.get("region"),
        base_url=resolved.get("baseUrl"),
        extra=extra,
    )


# Bounds how many times the cascade re-enters llm.generate() within a single
# turn to let the model consume tool results (record_info, goto_*, etc.) and
# produce a final spoken reply. Without a bound, a model that keeps calling
# tools instead of ever answering would hang the turn indefinitely.
MAX_TOOL_ROUNDS = 3


def _trim_history(messages: list[ChatMessage], max_turns: int = 40) -> list[ChatMessage]:
    """Cap conversation history so a long call doesn't grow the LLM request
    unboundedly. Keeps every `system` message (there are normally 1-2: the
    main system prompt, optionally a resume_context) plus the last
    `max_turns` non-system messages - but never splits an
    assistant-with-tool_calls message from the `tool` reply message(s) that
    must immediately follow it, since sending one without the other is
    rejected by OpenAI's API (a `tool` message with no preceding matching
    `tool_calls` id, or vice versa)."""
    system = [m for m in messages if m.role == "system"]
    rest = [m for m in messages if m.role != "system"]
    if len(rest) <= max_turns:
        return system + rest
    trimmed = rest[-max_turns:]
    # If the cut landed on a `tool` message, its pairing assistant message
    # (and any sibling `tool` messages answering the same multi-call round)
    # got cut too - walk the cut point back to the start of that round.
    while trimmed and trimmed[0].role == "tool":
        trimmed = trimmed[1:]
    return system + trimmed


async def _bytes_iter(chunks: list[bytes]) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


class PlayerAudioSink:
    """Adapts an AudioSocket connection's PacedPlayer + bot-speaking flag to
    the OutgoingAudioSink Protocol providers push audio through, so pipeline
    code never depends on PacedPlayer's concrete implementation."""

    def __init__(self, player, set_bot_speaking: Callable[[bool], None]) -> None:
        self._player = player
        self._set_bot_speaking = set_bot_speaking

    def push(self, chunk: bytes) -> None:
        self._set_bot_speaking(True)
        self._player.enqueue(chunk)

    def barge_in_stop(self) -> None:
        self._player.flush()
        self._set_bot_speaking(False)


@dataclass
class PipelineRunner:
    """Owns the queue of inbound audio the AudioSocket loop feeds it via
    `push_audio`, and drives whichever pipeline mode `config.pipeline_mode`
    calls for. One instance per call."""

    config: AiAgentConfig
    audio_sink: OutgoingAudioSink
    transcript: list[TranscriptTurn]
    set_bot_speaking: Callable[[bool], None]
    # This connection's own AudioSocket UUID - needed to call
    # POST /api/internal/ai/escalate (escalate/route.ts resolves the
    # caller's Asterisk channel by matching this against CoreShowChannels'
    # Uniqueid). Defaults to "" only so existing call sites/tests that don't
    # care about escalation don't have to pass it; main.py always does.
    call_uuid: str = ""
    # Set by main.py only when this runner is driving a RESUMED conference
    # leg (see main.py's LiveSession/resume_of handling) - an extra system
    # message telling the model it is now in a 3-way conference, appended
    # after the normal system prompt. None for a normal, non-resumed call.
    resume_context: Optional[str] = None
    # Also set only for a resumed conference leg: main.py already spoke (or
    # decided not to speak) a greeting on the ORIGINAL leg; the resumed leg
    # must never repeat it.
    skip_greeting: bool = False
    # Set once the model calls request_human_handoff (see pipeline/tools.py).
    # Read by main.py after the runner stops for logging/diagnostics.
    escalation_request: Optional[ToolCall] = field(default=None, init=False)
    # Set once EscalationController.request_handoff() returns - main.py
    # reads `.merged`/`.target_label` after the runner stops to decide the
    # SessionReport outcome ("handed_off" vs "completed") and
    # handoff_extension_id. None until an escalation attempt actually
    # completes (request_human_handoff never called, or still in flight).
    escalation_outcome: Optional[EscalationOutcome] = field(default=None, init=False)
    # True once a request_human_handoff attempt has resolved without
    # merging, for the lifetime of this connection - unlike
    # escalation_request/escalation_outcome (cleared after each attempt so
    # a retry is possible, see _run_cascade), this never resets: it's what
    # gates offering REQUEST_CALLBACK_TOOL, which must only appear AFTER a
    # real transfer attempt has already failed, never before one.
    handoff_failed_once: bool = field(default=False, init=False)
    # VAD/endpointing tunables - defaulted to the values that were hardcoded
    # module constants before this field existed, so behavior is unchanged
    # unless a caller (main.py, once agent-config's `vad` block is wired in
    # a later phase) explicitly passes something else.
    voice_energy_threshold: float = VOICE_ENERGY_THRESHOLD
    end_of_utterance_silent_frames: int = END_OF_UTTERANCE_SILENT_FRAMES
    # Workflow-builder state (2026-09-15) - populated only when
    # config.is_workflow; read by main.py's _report_session at call end
    # (see session_reporter.SessionReport.gathered_context/node_path).
    # Both stay empty/None for a SIMPLE-mode call.
    gathered_context: dict = field(default_factory=dict, init=False)
    node_path: list = field(default_factory=list, init=False)
    http_tool_client: HttpToolClient = field(default_factory=HttpToolClient)
    _audio_queue: "asyncio.Queue[Optional[bytes]]" = field(default_factory=asyncio.Queue, init=False)
    _task: Optional[asyncio.Task] = field(default=None, init=False)
    _closed: bool = field(default=False, init=False)

    def start(self) -> None:
        if self.config.is_realtime and self.config.is_workflow:
            self._task = asyncio.create_task(self._run_workflow_realtime())
        elif self.config.is_realtime:
            self._task = asyncio.create_task(self._run_realtime())
        elif self.config.is_workflow:
            self._task = asyncio.create_task(self._run_workflow_cascade())
        else:
            self._task = asyncio.create_task(self._run_cascade())

    def push_audio(self, chunk: bytes) -> None:
        if not self._closed:
            self._audio_queue.put_nowait(chunk)

    async def stop(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._audio_queue.put_nowait(None)
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            except Exception:
                logger.exception("Pipeline task for agent %s raised on shutdown", self.config.agent_id)

    async def _audio_iter(self) -> AsyncIterator[bytes]:
        while True:
            chunk = await self._audio_queue.get()
            if chunk is None:
                break
            yield chunk

    def _escalation_tools(self) -> list[ToolSpec]:
        """The request_human_handoff tool is only advertised when the
        Next.js side actually resolved a live escalation target
        (config.handoff_extension_hint - see agent-config/route.ts, which
        deliberately returns null when AiAgent.escalationEnabled is false
        or no target is configured yet). An agent with escalation off must
        never be given the tool at all, not just have its use ignored -
        offering a tool the model can call but that does nothing would be a
        worse failure than not offering it.

        REQUEST_CALLBACK_TOOL is added only AFTER handoff_failed_once is
        set - offering "arrange a callback" before a real transfer has ever
        been attempted would let the model skip straight to it instead of
        actually trying to reach a human first."""
        if not self.config.handoff_extension_hint:
            return []
        tools = [REQUEST_HUMAN_HANDOFF_TOOL]
        if self.handoff_failed_once:
            tools.append(REQUEST_CALLBACK_TOOL)
        return tools

    async def _run_realtime(self) -> None:
        leg = self.config.realtime
        if leg is None:
            logger.error("REALTIME pipeline_mode with no realtime leg config for agent %s", self.config.agent_id)
            return
        provider = build_realtime(_leg_config(leg), system_prompt=self.config.system_prompt)

        async def on_tool_call(tc: ToolCall) -> None:
            was_escalation = tc.name in (REQUEST_HUMAN_HANDOFF, REQUEST_CALLBACK)
            result = await self._handle_tool_call(tc, tts=None)
            if was_escalation:
                # Escalation side-effects (hold/merge, or an apology already
                # spoken by EscalationController) - the call is either ending
                # or the model should simply keep listening, not receive a
                # synthetic tool result to react to.
                return
            # Generic tool (record_info/goto_*/http_tool - wired in the
            # workflow-runtime phase): feed the result back so the live
            # session can act on it and continue speaking.
            await provider.send_tool_result(tc.call_id, tc.name, result)

        try:
            await provider.run(
                self._audio_iter(),
                self.audio_sink,
                tools=self._escalation_tools(),
                on_tool_call=on_tool_call,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Realtime provider failed for agent %s", self.config.agent_id)

    async def _run_workflow_realtime(self) -> None:
        """A node graph drives a REALTIME (speech-to-speech) call. Only
        OpenAI Realtime supports this - `update_session()` is a genuine
        mid-session instructions/tools swap (see openai_realtime.py). Gemini
        Live's `setup` is send-once-at-connection with no such mechanism
        (see GeminiRealtime's class docstring); the workflow publish-time
        validator (workflow-schema.ts) already rejects WORKFLOW + Gemini
        realtime, but this method defends against it anyway - config
        reaching here with a Gemini leg falls back to the plain single-
        prompt realtime loop rather than silently ignoring the graph.

        Unlike cascade mode, ONE realtime provider instance drives the
        WHOLE call (a vendor session can't be swapped mid-call the way a
        cascade turn can pick a different LLM per node) - so per-node model
        overrides are NOT applied in this mode; only instructions and tools
        change per node via update_session(). This is a real, stated
        simplification, not an oversight - see the workflow-builder plan.
        """
        if self.config.workflow is None or self.config.realtime is None:
            logger.error(
                "REALTIME workflow mode with no workflow/realtime config for agent %s; falling back",
                self.config.agent_id,
            )
            await self._run_realtime()
            return
        if self.config.realtime.provider == "gemini":
            logger.error(
                "REALTIME workflow mode requested with a Gemini realtime leg for agent %s - unsupported "
                "(Gemini Live cannot update instructions mid-session); falling back to single-prompt realtime",
                self.config.agent_id,
            )
            await self._run_realtime()
            return
        try:
            graph = WorkflowGraph.from_payload(self.config.workflow["graph"])
        except (WorkflowParseError, KeyError):
            logger.exception(
                "Workflow graph failed to parse for agent %s; falling back to single-prompt realtime",
                self.config.agent_id,
            )
            await self._run_realtime()
            return
        start = graph.start_node()
        if start is None:
            logger.error("Workflow graph for agent %s has no START_CALL node; falling back", self.config.agent_id)
            await self._run_realtime()
            return

        self._workflow_provider_cache = {}
        global_node = graph.global_node()
        initial_context = {
            "caller_number": "",
            "called_extension": self.config.extension_number,
            "agent_name": "",
            "now_local": datetime.now(timezone.utc).isoformat(),
        }

        self.node_path.append(start.id)
        next_node = self._next_node_after_automatic(graph, start)
        if next_node is not None:
            self.node_path.append(next_node.id)
        current = await self._drain_automatic_nodes(graph, next_node, initial_context) if next_node else None
        if current is None:
            # The graph ended (or hit a dead end) before any live session
            # was ever needed - e.g. Start -> HTTP lookup -> End Call.
            return

        provider = build_realtime(_leg_config(self.config.realtime), system_prompt="")
        state = {"current": current}

        async def on_tool_call(tc: ToolCall) -> None:
            if tc.name in (REQUEST_HUMAN_HANDOFF, REQUEST_CALLBACK):
                await self._handle_tool_call(tc, tts=None)
                return  # escalation side-effects, no synthetic result to send back

            node = state["current"]
            tool_map = pathway_tool_map(graph, node)
            if tc.name == RECORD_INFO_TOOL_NAME:
                self.gathered_context.update(tc.arguments)
                await provider.send_tool_result(tc.call_id, tc.name, {"ok": True})
                return
            if tc.name not in tool_map:
                await provider.send_tool_result(tc.call_id, tc.name, {"ok": False, "error": "unknown tool"})
                return

            target = graph.node(tool_map[tc.name].target)
            if target is None:
                await provider.send_tool_result(tc.call_id, tc.name, {"ok": False, "error": "edge target missing"})
                return
            await provider.send_tool_result(tc.call_id, tc.name, {"ok": True, "moved_to": target.id})
            self.node_path.append(target.id)

            if target.kind == "TRANSFER":
                await self._enter_transfer_node(target)
                # No further update_session - the connection is expected to
                # tear down (a real merge) or the caller stays on this same
                # live session after a failed attempt (EscalationController
                # already spoke the apology via TTS in cascade mode; in
                # REALTIME there is no TTS leg to speak through here either
                # - same documented gap _make_speak already carries).
                return

            drained = await self._drain_automatic_nodes(graph, target, initial_context)
            if drained is None:
                # Landed on END_CALL - tell the live session to say goodbye
                # and stop offering any further pathway tools; the sidecar
                # cannot force a hangup itself (no AMI access - see this
                # module's docstring), so the call ends when Asterisk/the
                # caller does, same as every other REALTIME limitation here.
                await provider.update_session(target.prompt or "Say goodbye and end the conversation.", [])
                return

            state["current"] = drained
            tools = pathway_tools(graph, drained)
            extraction = extraction_tool(drained)
            if extraction is not None:
                tools.append(extraction)
            tools.extend(self._escalation_tools())
            instructions = system_prompt_for(
                drained, global_node, self.config.system_prompt, initial_context, self.gathered_context
            )
            await provider.update_session(instructions, tools)

        initial_tools = pathway_tools(graph, current)
        initial_extraction = extraction_tool(current)
        if initial_extraction is not None:
            initial_tools.append(initial_extraction)
        initial_tools.extend(self._escalation_tools())
        provider.system_prompt = system_prompt_for(
            current, global_node, self.config.system_prompt, initial_context, self.gathered_context
        )

        try:
            await provider.run(self._audio_iter(), self.audio_sink, tools=initial_tools, on_tool_call=on_tool_call)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Workflow realtime provider failed for agent %s", self.config.agent_id)

    async def _make_speak(self, tts):
        async def speak(text: str) -> None:
            self.transcript.append(TranscriptTurn(role="agent", text=text))
            if tts is not None:
                await self._speak(tts, text)
            else:
                # REALTIME mode: no TTS leg to synthesize an ad-hoc prompt
                # through - see this module's docstring and escalation.py's
                # own module docstring for why that gap is left open rather
                # than faked.
                logger.info(
                    "Escalation prompt for call %s not spoken (no TTS available in REALTIME mode): %r",
                    self.call_uuid,
                    text,
                )

        return speak

    async def _handle_tool_call(self, tool_call: ToolCall, *, tts) -> dict:
        """Shared by both pipeline modes (see _run_cascade's turn loop, which
        passes its own `tts`, and _run_realtime's on_tool_call, which has
        none to pass). Drives the actual escalation flow via
        EscalationController (escalation.py), which calls Next.js's
        `POST /api/internal/ai/escalate` for every AMI action - this method,
        and everything in pipeline/, never touch AMI directly. Dispatches on
        tool name since REQUEST_CALLBACK_TOOL (only ever offered after a
        failed request_human_handoff - see _escalation_tools) shares this
        same entry point.

        Returns a JSON-serializable result dict. For the two escalation
        tools this return value is never fed back to the model (see
        _run_cascade/_run_realtime - escalation always short-circuits the
        turn instead), but every call site needs a consistent return type
        for the tool-result-feedback dispatch to stay generic; any other
        (future workflow) tool's result IS fed back, which is the whole
        point of this method returning a dict rather than None."""
        speak = await self._make_speak(tts)
        controller = EscalationController(agent_id=self.config.agent_id, call_uuid=self.call_uuid, speak=speak)

        if tool_call.name == REQUEST_HUMAN_HANDOFF:
            self.escalation_request = tool_call
            reason = tool_call.arguments.get("reason", "")
            self.transcript.append(TranscriptTurn(role="agent", text=f"[requesting human handoff: {reason}]"))
            outcome = await controller.request_handoff(reason)
            self.escalation_outcome = outcome
            if not outcome.merged:
                self.handoff_failed_once = True
            return {"merged": outcome.merged}

        if tool_call.name == REQUEST_CALLBACK:
            reason = tool_call.arguments.get("reason", "")
            self.transcript.append(TranscriptTurn(role="agent", text=f"[requesting callback: {reason}]"))
            await controller.request_callback(reason)
            return {"ok": True}

        logger.warning("Unknown tool call '%s' for agent %s", tool_call.name, self.config.agent_id)
        return {"ok": False, "error": f"unknown tool '{tool_call.name}'"}

    async def _generate_turn_reply(self, messages: list[ChatMessage], llm, tts) -> tuple[str, bool]:
        """Runs the LLM for the current turn, feeding tool results back and
        re-generating (up to MAX_TOOL_ROUNDS times) until it produces plain
        text with no further tool calls. Mutates `messages` in place with
        every assistant/tool exchange, so the conversation carries the full
        round when this returns.

        Returns `(reply_text, escalated)`. `escalated=True` means an
        escalation tool (request_human_handoff/request_callback) fired
        during this turn - by design that short-circuits the generic
        tool-feedback loop entirely (unchanged from the pre-existing
        behavior: escalation is a side-effecting call to AMI/CRM, not
        something the model should keep reasoning about in the same turn),
        and `reply_text` is "" in that case; the caller checks
        self.escalation_request/self.escalation_outcome exactly as before."""
        tools = self._escalation_tools()
        for _round in range(MAX_TOOL_ROUNDS + 1):
            text_parts: list[str] = []
            tool_calls: list[ToolCall] = []
            async for delta in llm.generate(messages, tools=tools):
                if delta.tool_call is not None:
                    tool_calls.append(delta.tool_call)
                elif delta.text:
                    text_parts.append(delta.text)

            if not tool_calls:
                return "".join(text_parts).strip(), False

            escalation_calls = [tc for tc in tool_calls if tc.name in (REQUEST_HUMAN_HANDOFF, REQUEST_CALLBACK)]
            if escalation_calls:
                # Handle (at most) the first escalation call in this batch -
                # a model asking for both handoff and callback in one turn
                # is a model bug; acting on one and dropping the rest is
                # safer than dispatching to Asterisk/CRM twice for one turn.
                await self._handle_tool_call(escalation_calls[0], tts=tts)
                return "", True

            tool_calls = [tc if tc.call_id else ToolCall(tc.name, tc.arguments, uuid4().hex) for tc in tool_calls]
            messages.append(ChatMessage(role="assistant", content="", tool_calls=tool_calls))
            for tc in tool_calls:
                result = await self._handle_tool_call(tc, tts=tts)
                messages.append(
                    ChatMessage(role="tool", content=json.dumps(result), tool_call_id=tc.call_id, name=tc.name)
                )

        logger.warning(
            "Turn for agent %s hit MAX_TOOL_ROUNDS (%d) without a final reply; giving up on this turn",
            self.config.agent_id,
            MAX_TOOL_ROUNDS,
        )
        return "", False

    async def _run_cascade(self) -> None:
        if self.config.stt is None or self.config.llm is None or self.config.tts is None:
            logger.error("CASCADE pipeline_mode missing an stt/llm/tts leg for agent %s", self.config.agent_id)
            return
        stt = build_stt(_leg_config(self.config.stt))
        llm = build_llm(_leg_config(self.config.llm))
        tts = build_tts(_leg_config(self.config.tts))
        messages = [ChatMessage(role="system", content=self.config.system_prompt)]
        if self.resume_context:
            # A resumed conference leg (main.py's LiveSession/resume_of
            # handling) - tell the model what changed without re-fetching
            # config or re-speaking the greeting (skip_greeting below).
            messages.append(ChatMessage(role="system", content=self.resume_context))

        try:
            if self.config.greeting and not self.skip_greeting:
                self.transcript.append(TranscriptTurn(role="agent", text=self.config.greeting))
                await self._speak(tts, self.config.greeting)

            while True:
                utterance = await self._collect_utterance()
                if utterance is None:
                    break
                if not utterance:
                    continue

                text = (await stt.transcribe_stream(_bytes_iter(utterance))).strip()
                if not text:
                    continue
                messages.append(ChatMessage(role="user", content=text))
                self.transcript.append(TranscriptTurn(role="caller", text=text))

                messages[:] = _trim_history(messages)
                reply, escalated = await self._generate_turn_reply(messages, llm, tts)

                if escalated:
                    if self.escalation_outcome is not None and self.escalation_outcome.merged:
                        # The caller has already been AMI-Redirected out of
                        # this AudioSocket connection - nothing more to do
                        # here, the socket will EOF shortly as Asterisk
                        # tears down this leg.
                        break
                    # Escalation was requested but did NOT merge (blocked or
                    # failed) - EscalationController already spoke the
                    # apology. Clear the request/outcome so a later attempt
                    # in a future turn is possible, and keep talking rather
                    # than ending the call over a failed transfer.
                    self.escalation_request = None
                    self.escalation_outcome = None
                    continue

                if not reply:
                    continue
                messages.append(ChatMessage(role="assistant", content=reply))
                self.transcript.append(TranscriptTurn(role="agent", text=reply))

                await self._speak(tts, reply)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Cascade pipeline failed for agent %s", self.config.agent_id)

    # --- Workflow cascade (2026-09-15) ---------------------------------------
    #
    # A node graph drives the call instead of one flat prompt - see
    # pipeline/workflow.py for the pure graph helpers this method wires into
    # an actual AudioSocket call. Design notes:
    #   - Conversation history (`messages`) is CONTINUOUS across nodes; only
    #     the system message is rebuilt each round from the current node -
    #     resetting history per node would make the bot forget what the
    #     caller just said.
    #   - Transitions happen only at tool-call granularity, never mid-
    #     sentence: a goto_* call updates `current` before the next
    #     generate() round, which is the FIRST point the new node's system
    #     prompt/tools take effect.
    #   - Per-node LLM/TTS provider instances are built lazily and cached
    #     (`self._workflow_provider_cache`) so a many-node graph doesn't open
    #     a fresh HTTP client per node per turn.
    #   - HTTP_TOOL/END_CALL/TRANSFER nodes reached via a goto are handled
    #     WITHOUT another llm.generate() round - an End Call node's farewell
    #     is its own `prompt` (template-rendered), not something the model
    #     is asked to improvise once it's already been told the call is
    #     over; a Transfer node reuses EscalationController directly.

    def _leg_for_node(self, node: WorkflowNode, *, leg_kind: str, cache: dict):
        """Returns a built provider instance for `node`'s `leg_kind` ("llm"
        or "tts"), using its resolved modelOverride credential if the graph
        has one, else falling back to the agent's own default leg. Cached
        per (kind, node.id) so repeat turns on the same node reuse the same
        provider instance rather than rebuilding it."""
        key = (leg_kind, node.id)
        if key in cache:
            return cache[key]
        resolved_by_node = self.config.workflow.get("resolvedByNodeId", {}) if self.config.workflow else {}
        entry = resolved_by_node.get(node.id, {}).get(leg_kind)
        if entry:
            leg = _resolved_leg_config(entry, leg_kind=leg_kind)
        else:
            default_leg = self.config.llm if leg_kind == "llm" else self.config.tts
            if default_leg is None:
                cache[key] = None
                return None
            leg = _leg_config(default_leg)
        provider = build_llm(leg) if leg_kind == "llm" else build_tts(leg)
        cache[key] = provider
        return provider

    async def _speak_node_prompt(self, node: WorkflowNode, tts, initial_context: dict) -> None:
        if not node.prompt.strip() or tts is None:
            return
        from .workflow import render

        text = render(node.prompt, initial_context, self.gathered_context)
        self.transcript.append(TranscriptTurn(role="agent", text=text))
        await self._speak(tts, text)

    async def _enter_transfer_node(self, node: WorkflowNode) -> None:
        """A Transfer node is a DELIBERATE, deterministic endpoint of this
        graph path - unlike the free-form request_human_handoff tool
        (offered during normal AGENT-node conversation and re-triable), a
        Transfer node has no outgoing edges (workflow-schema.ts's own
        validation enforces this), so there is no defined "what happens on
        failure" branch in the graph model. Known, stated simplification:
        on a failed transfer, the workflow ends here rather than silently
        reverting to free-form chat - EscalationController has already
        spoken an apology via its own speak() callback, so the caller still
        hears something coherent before the call proceeds to hang up."""
        speak = await self._make_speak(self._leg_for_node(node, leg_kind="tts", cache=self._workflow_provider_cache))
        controller = EscalationController(agent_id=self.config.agent_id, call_uuid=self.call_uuid, speak=speak)
        reason = f"workflow transfer via node '{node.label}'"
        self.transcript.append(TranscriptTurn(role="agent", text=f"[workflow transfer: {node.label}]"))
        outcome = await controller.request_handoff(reason)
        self.escalation_request = ToolCall(name=REQUEST_HUMAN_HANDOFF, arguments={"reason": reason})
        self.escalation_outcome = outcome

    async def _run_http_tool_node(self, node: WorkflowNode) -> None:
        """HTTP_TOOL nodes are automatic - no caller utterance is collected
        at this node. The actual HTTP call happens server-side in Next.js
        (see http_tool_client.py's module docstring for why); this method
        only records the outcome into gathered_context and the transcript.
        On a client/network error, the call is logged and treated as a
        no-op result (`{"ok": False}`) rather than raising - a live call
        must never crash on an HTTP tool node's own request failing."""
        try:
            result = await self.http_tool_client.call(
                agent_id=self.config.agent_id, node_id=node.id, gathered_context=self.gathered_context
            )
        except HttpToolRequestError:
            logger.exception("HTTP tool node '%s' failed for agent %s", node.id, self.config.agent_id)
            result = {"ok": False, "error": "request_failed"}
        if result.get("ok") and isinstance(result.get("extracted"), dict):
            self.gathered_context.update(result["extracted"])
        self.transcript.append(
            TranscriptTurn(role="agent", text=f"[http tool: {node.label} -> ok={result.get('ok')}]")
        )

    def _next_node_after_automatic(self, graph: WorkflowGraph, node: WorkflowNode) -> Optional[WorkflowNode]:
        """HTTP_TOOL nodes don't involve the model choosing a pathway (no
        turn happens there to call a goto_* tool) - deterministically follow
        the first outgoing edge. A node with more than one outgoing edge is
        unusual for this kind (nothing here decides between them); documented
        limitation, not silently arbitrary - logged when it happens."""
        edges = graph.outgoing_edges(node.id)
        if not edges:
            return None
        if len(edges) > 1:
            logger.warning(
                "HTTP_TOOL node '%s' has %d outgoing edges; taking the first one (no model turn happens at this node kind to choose)",
                node.id,
                len(edges),
            )
        return graph.node(edges[0].target)

    async def _run_workflow_cascade(self) -> None:  # noqa: C901 - node-graph interpreter, inherently branchy
        if self.config.workflow is None:
            logger.error("is_workflow was true but config.workflow is None for agent %s", self.config.agent_id)
            return
        try:
            graph = WorkflowGraph.from_payload(self.config.workflow["graph"])
        except (WorkflowParseError, KeyError):
            logger.exception(
                "Workflow graph failed to parse for agent %s; falling back to the simple cascade",
                self.config.agent_id,
            )
            await self._run_cascade()
            return

        start = graph.start_node()
        if start is None or self.config.stt is None:
            logger.error(
                "Workflow graph for agent %s has no START_CALL node, or no stt leg configured; falling back",
                self.config.agent_id,
            )
            await self._run_cascade()
            return

        self._workflow_provider_cache: dict = {}
        stt = build_stt(_leg_config(self.config.stt))
        global_node = graph.global_node()
        initial_context = {
            # KNOWN LIMITATION, stated not hidden: caller_number and
            # agent_name are not yet plumbed from Asterisk/AiAgentConfig
            # into PipelineRunner - both template refs resolve to "" until a
            # follow-up threads them through (config_client's
            # AiAgentConfig has no `caller_number`/`display name` field
            # today; see agent-config/route.ts's contract).
            "caller_number": "",
            "called_extension": self.config.extension_number,
            "agent_name": "",
            "now_local": datetime.now(timezone.utc).isoformat(),
        }

        current: Optional[WorkflowNode] = start
        self.node_path.append(current.id)

        try:
            # START_CALL speaks its own prompt if it has one, else the
            # agent's top-level greeting (identical to SIMPLE mode's
            # behavior) - then auto-advances deterministically, same as any
            # other automatic node.
            start_tts = self._leg_for_node(current, leg_kind="tts", cache=self._workflow_provider_cache)
            if not self.skip_greeting:
                if current.prompt.strip():
                    await self._speak_node_prompt(current, start_tts, initial_context)
                elif self.config.greeting:
                    self.transcript.append(TranscriptTurn(role="agent", text=self.config.greeting))
                    if start_tts is not None:
                        await self._speak(start_tts, self.config.greeting)

            next_node = self._next_node_after_automatic(graph, current)
            if next_node is None:
                return  # a graph that ends the call right at Start Call - unusual but not invalid
            current = next_node
            self.node_path.append(current.id)

            # Drain any HTTP_TOOL/terminal nodes reached before the first
            # real conversational turn (e.g. Start Call -> HTTP lookup ->
            # Agent).
            current = await self._drain_automatic_nodes(graph, current, initial_context)
            if current is None:
                return

            messages: list[ChatMessage] = []
            while True:
                utterance = await self._collect_utterance()
                if utterance is None:
                    return
                if not utterance:
                    continue

                text = (await stt.transcribe_stream(_bytes_iter(utterance))).strip()
                if not text:
                    continue
                messages.append(ChatMessage(role="user", content=text))
                self.transcript.append(TranscriptTurn(role="caller", text=text))
                messages[:] = _trim_history(messages)

                current, reply_text, call_ended = await self._run_workflow_turn(
                    graph, current, global_node, messages, initial_context
                )
                if reply_text:
                    tts = self._leg_for_node(current, leg_kind="tts", cache=self._workflow_provider_cache)
                    messages.append(ChatMessage(role="assistant", content=reply_text))
                    self.transcript.append(TranscriptTurn(role="agent", text=reply_text))
                    if tts is not None:
                        await self._speak(tts, reply_text)
                if call_ended:
                    return
                current = await self._drain_automatic_nodes(graph, current, initial_context)
                if current is None:
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Workflow cascade failed for agent %s", self.config.agent_id)

    async def _drain_automatic_nodes(
        self, graph: WorkflowGraph, node: WorkflowNode, initial_context: dict
    ) -> Optional[WorkflowNode]:
        """Advances through any number of consecutive HTTP_TOOL nodes (and
        handles landing on END_CALL/TRANSFER) with no caller utterance in
        between - these node kinds never wait for the caller to speak.
        Returns the next AGENT node the turn loop should collect an
        utterance for, or None if the call ended (END_CALL/TRANSFER)."""
        while node.kind == "HTTP_TOOL":
            await self._run_http_tool_node(node)
            next_node = self._next_node_after_automatic(graph, node)
            if next_node is None:
                return None
            node = next_node
            self.node_path.append(node.id)

        if node.kind == "END_CALL":
            tts = self._leg_for_node(node, leg_kind="tts", cache=self._workflow_provider_cache)
            await self._speak_node_prompt(node, tts, initial_context)
            return None
        if node.kind == "TRANSFER":
            await self._enter_transfer_node(node)
            return None
        return node

    async def _run_workflow_turn(
        self,
        graph: WorkflowGraph,
        current: WorkflowNode,
        global_node: Optional[WorkflowNode],
        messages: list[ChatMessage],
        initial_context: dict,
    ) -> tuple[WorkflowNode, str, bool]:
        """Runs the LLM for one caller utterance against the CURRENT node's
        tools/system-prompt, feeding tool results back (record_info updates
        gathered_context, goto_* moves `current`) and re-generating up to
        MAX_TOOL_ROUNDS times, same shape as _generate_turn_reply's
        cascade-mode round loop. Returns `(node_after_this_turn, reply_text,
        call_ended)` - `call_ended` is True once a goto_* lands on
        END_CALL/TRANSFER, which this method handles directly (no further
        generate() round - see the class-level docstring above) rather than
        asking the model to improvise a farewell it wasn't prompted for."""
        llm = self._leg_for_node(current, leg_kind="llm", cache=self._workflow_provider_cache)
        if llm is None:
            logger.error("No LLM available for workflow node '%s', agent %s", current.id, self.config.agent_id)
            return current, "", True

        for _round in range(MAX_TOOL_ROUNDS + 1):
            system_text = system_prompt_for(
                current, global_node, self.config.system_prompt, initial_context, self.gathered_context
            )
            full_messages = [ChatMessage(role="system", content=system_text)] + messages
            tool_map = pathway_tool_map(graph, current)
            tools = list(pathway_tools(graph, current))
            extraction = extraction_tool(current)
            if extraction is not None:
                tools.append(extraction)
            tools.extend(self._escalation_tools())

            text_parts: list[str] = []
            tool_calls: list[ToolCall] = []
            async for delta in llm.generate(full_messages, tools=tools):
                if delta.tool_call is not None:
                    tool_calls.append(delta.tool_call)
                elif delta.text:
                    text_parts.append(delta.text)

            if not tool_calls:
                return current, "".join(text_parts).strip(), False

            escalation_calls = [tc for tc in tool_calls if tc.name in (REQUEST_HUMAN_HANDOFF, REQUEST_CALLBACK)]
            if escalation_calls:
                tts = self._leg_for_node(current, leg_kind="tts", cache=self._workflow_provider_cache)
                await self._handle_tool_call(escalation_calls[0], tts=tts)
                if self.escalation_outcome is not None and self.escalation_outcome.merged:
                    return current, "", True
                self.escalation_request = None
                self.escalation_outcome = None
                return current, "", False

            tool_calls = [tc if tc.call_id else ToolCall(tc.name, tc.arguments, uuid4().hex) for tc in tool_calls]
            messages.append(ChatMessage(role="assistant", content="", tool_calls=tool_calls))
            moved_to: Optional[WorkflowNode] = None
            for tc in tool_calls:
                if tc.name == RECORD_INFO_TOOL_NAME:
                    self.gathered_context.update(tc.arguments)
                    result: dict = {"ok": True}
                elif tc.name in tool_map:
                    target = graph.node(tool_map[tc.name].target)
                    if target is not None:
                        moved_to = target
                        result = {"ok": True, "moved_to": target.id}
                    else:
                        result = {"ok": False, "error": "edge target no longer exists"}
                else:
                    result = {"ok": False, "error": f"unknown tool '{tc.name}'"}
                messages.append(
                    ChatMessage(role="tool", content=json.dumps(result), tool_call_id=tc.call_id, name=tc.name)
                )

            if moved_to is not None:
                current = moved_to
                self.node_path.append(current.id)
                if current.kind in ("END_CALL", "TRANSFER"):
                    # No further generate() round - see this method's
                    # docstring for why these two kinds are handled
                    # directly rather than via another LLM turn.
                    if current.kind == "END_CALL":
                        tts = self._leg_for_node(current, leg_kind="tts", cache=self._workflow_provider_cache)
                        await self._speak_node_prompt(current, tts, initial_context)
                    else:
                        await self._enter_transfer_node(current)
                    return current, "", True
                # Moved to another AGENT/HTTP_TOOL node - loop again so the
                # next round's system prompt/tools reflect the new node
                # (HTTP_TOOL is drained by the caller after this method
                # returns, via _drain_automatic_nodes, if `current` is left
                # in that state without ending the turn here - but an
                # HTTP_TOOL node has no conversational tools of its own, so
                # continuing this loop with it would offer none and the
                # model would just fall through to a text reply; simplest
                # correct behavior is to stop this turn's generation here
                # and let the caller's _drain_automatic_nodes run it).
                if current.kind == "HTTP_TOOL":
                    return current, "", False

        logger.warning(
            "Workflow turn for agent %s hit MAX_TOOL_ROUNDS (%d) without a final reply",
            self.config.agent_id,
            MAX_TOOL_ROUNDS,
        )
        return current, "", False

    async def _speak(self, tts, text: str) -> None:
        async for audio_chunk in tts.synthesize(text):
            self.audio_sink.push(audio_chunk)
        self.set_bot_speaking(False)

    async def _collect_utterance(self) -> Optional[list[bytes]]:
        """Buffer inbound audio until END_OF_UTTERANCE_SILENT_FRAMES
        consecutive silent frames follow at least one voiced frame. Returns
        None once the call ends (queue closed via `stop()`); returns an
        empty list if the call is still live but nothing voiced arrived
        before the caller's turn is re-checked (never actually happens in
        practice since this only returns on voiced-then-silent or closure,
        kept for a clean Optional[list] contract)."""
        frames: list[bytes] = []
        silent_run = 0
        heard_voice = False
        while True:
            chunk = await self._audio_queue.get()
            if chunk is None:
                return None
            energy = frame_energy(chunk)
            if energy >= self.voice_energy_threshold:
                heard_voice = True
                silent_run = 0
                frames.append(chunk)
            elif heard_voice:
                silent_run += 1
                frames.append(chunk)
                if silent_run >= self.end_of_utterance_silent_frames:
                    return frames
            # else: silence before any speech observed yet - drop and keep waiting.
