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
import logging
from dataclasses import dataclass, field
from typing import AsyncIterator, Callable, Optional

from audiosocket.protocol import frame_energy
from config_client import AiAgentConfig, LegConfig
from escalation import EscalationController, EscalationOutcome
from session_reporter import TranscriptTurn

from .base import ChatMessage, OutgoingAudioSink, ProviderLegConfig, ToolCall, ToolSpec
from .registry import build_llm, build_realtime, build_stt, build_tts
from .tools import REQUEST_CALLBACK, REQUEST_CALLBACK_TOOL, REQUEST_HUMAN_HANDOFF, REQUEST_HUMAN_HANDOFF_TOOL

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
    )


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
    _audio_queue: "asyncio.Queue[Optional[bytes]]" = field(default_factory=asyncio.Queue, init=False)
    _task: Optional[asyncio.Task] = field(default=None, init=False)
    _closed: bool = field(default=False, init=False)

    def start(self) -> None:
        if self.config.is_realtime:
            self._task = asyncio.create_task(self._run_realtime())
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
        try:
            await provider.run(
                self._audio_iter(),
                self.audio_sink,
                tools=self._escalation_tools(),
                on_tool_call=lambda tc: self._handle_tool_call(tc, tts=None),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Realtime provider failed for agent %s", self.config.agent_id)

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

    async def _handle_tool_call(self, tool_call: ToolCall, *, tts) -> None:
        """Shared by both pipeline modes (see _run_cascade's llm.generate
        loop, which passes its own `tts`, and _run_realtime's on_tool_call
        above, which has none to pass). Drives the actual escalation flow
        via EscalationController (escalation.py), which calls Next.js's
        `POST /api/internal/ai/escalate` for every AMI action - this method,
        and everything in pipeline/, never touch AMI directly. Dispatches on
        tool name since REQUEST_CALLBACK_TOOL (only ever offered after a
        failed request_human_handoff - see _escalation_tools) shares this
        same entry point."""
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
            return

        if tool_call.name == REQUEST_CALLBACK:
            reason = tool_call.arguments.get("reason", "")
            self.transcript.append(TranscriptTurn(role="agent", text=f"[requesting callback: {reason}]"))
            await controller.request_callback(reason)
            return

        logger.warning("Unknown tool call '%s' for agent %s", tool_call.name, self.config.agent_id)

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

                reply_parts: list[str] = []
                async for delta in llm.generate(messages, tools=self._escalation_tools()):
                    if delta.tool_call is not None:
                        await self._handle_tool_call(delta.tool_call, tts=tts)
                        continue
                    if delta.text:
                        reply_parts.append(delta.text)

                if self.escalation_request is not None:
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

                reply = "".join(reply_parts).strip()
                if not reply:
                    continue
                messages.append(ChatMessage(role="assistant", content=reply))
                self.transcript.append(TranscriptTurn(role="agent", text=reply))

                await self._speak(tts, reply)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Cascade pipeline failed for agent %s", self.config.agent_id)

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
            if energy >= VOICE_ENERGY_THRESHOLD:
                heard_voice = True
                silent_run = 0
                frames.append(chunk)
            elif heard_voice:
                silent_run += 1
                frames.append(chunk)
                if silent_run >= END_OF_UTTERANCE_SILENT_FRAMES:
                    return frames
            # else: silence before any speech observed yet - drop and keep waiting.
