"""Abstract provider interfaces for the STT -> LLM -> TTS cascade and the
realtime speech-to-speech mode. All providers under `pipeline/providers/`
implement one or more of these Protocols.

Audio convention: unless documented otherwise on a specific provider, raw
audio chunks flowing through this pipeline are 8kHz, 16-bit signed-LE mono
PCM (slin) - the native AudioSocket format - as `bytes`. Providers that need
a different sample rate or encoding (e.g. Gemini Live's 16kHz in / 24kHz out,
or OpenAI Realtime's g711_ulaw) are responsible for their own
resampling/transcoding, documented in each provider module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable, Protocol, runtime_checkable


@dataclass
class ChatMessage:
    """One conversation turn.

    The tool fields exist because a tool *result* cannot be represented as a
    plain `{role, content}` pair: OpenAI rejects a `role="tool"` message that
    is not immediately preceded by an `assistant` message carrying a matching
    `tool_calls[].id`. So a completed tool round is always the pair

        ChatMessage(role="assistant", content="", tool_calls=[ToolCall(...)])
        ChatMessage(role="tool", tool_call_id=<same id>, name=..., content=<json>)

    and the two must never be separated (see `_trim_history` in runner.py,
    which is careful not to split them). Every field defaults, so existing
    `ChatMessage(role=..., content=...)` construction sites are unaffected.
    """

    role: str  # "system" | "user" | "assistant" | "tool"
    content: str
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    name: str | None = None


@dataclass
class ToolSpec:
    """One tool the LLM may call. `parameters` is a JSON-Schema object in the
    shape BOTH OpenAI's `tools[].function.parameters` and Gemini's
    `functionDeclarations[].parameters` accept, so one spec serves every
    provider without per-vendor rewriting."""

    name: str
    description: str
    parameters: dict = field(default_factory=dict)


@dataclass
class ToolCall:
    """A tool invocation the model asked for. `call_id` is the vendor's own
    id where one exists (OpenAI supplies it; Gemini Live does not), needed
    only to correlate a tool *result* back to the call."""

    name: str
    arguments: dict = field(default_factory=dict)
    call_id: str | None = None


@dataclass
class LlmDelta:
    """One item from a streaming LLM response: either a text fragment or a
    completed tool call, never both.

    A structured delta (rather than raw `str`) is what makes escalation
    reliable: "the caller wants a human" arrives as a typed ToolCall the
    runner can act on, instead of a sentinel phrase scraped out of prose
    that breaks the moment the model rewords itself or answers in Hindi.
    """

    text: str | None = None
    tool_call: ToolCall | None = None


@runtime_checkable
class SttProvider(Protocol):
    """Speech-to-text: consumes a stream of raw audio chunks, yields
    incremental/final transcripts."""

    async def transcribe_stream(self, audio_chunks: AsyncIterator[bytes]) -> str:
        """Consume the full audio stream for one utterance and return the
        final transcript text. Streaming implementations may also expose
        partials via provider-specific hooks, but this is the contract every
        SttProvider must satisfy for the cascade pipeline to work."""
        ...


@runtime_checkable
class LlmProvider(Protocol):
    """LLM text generation, with streaming output and optional tool-calling."""

    async def generate(
        self, messages: list[ChatMessage], tools: list[ToolSpec] | None = None
    ) -> AsyncIterator[LlmDelta]:
        """Stream response deltas for the given conversation. Each delta is
        either a text fragment or a completed tool call (see LlmDelta) -
        never mix the two in one delta. `tools` is None for providers/calls
        that don't need tool-calling; passing it costs nothing when the
        model doesn't invoke anything."""
        ...
        yield LlmDelta()  # pragma: no cover - Protocol body, never executed


@runtime_checkable
class TtsProvider(Protocol):
    """Text-to-speech: synthesizes audio chunks for a given text."""

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        """Yield raw audio chunks (see module docstring for the default
        8kHz/16-bit slin convention; providers documenting a different
        native output, e.g. ulaw_8000, note it in their own module)."""
        ...
        yield b""  # pragma: no cover - Protocol body, never executed


@runtime_checkable
class RealtimeProvider(Protocol):
    """Speech-to-speech: owns the full duplex audio exchange for a call leg,
    bypassing the STT/LLM/TTS cascade entirely (e.g. OpenAI Realtime, Gemini
    Live BidiGenerateContent)."""

    async def run(
        self,
        audio_in: AsyncIterator[bytes],
        audio_out: "OutgoingAudioSink",
        *,
        tools: list[ToolSpec] | None = None,
        on_tool_call: "Callable[[ToolCall], Awaitable[None]] | None" = None,
    ) -> None:
        """Drive the realtime session until the call ends or the provider
        session closes. `audio_in` yields raw inbound audio chunks (8kHz
        slin, AudioSocket-native); implementations push synthesized audio to
        `audio_out` as they receive it from the vendor. When `tools` is
        given, the provider advertises them to the vendor session and awaits
        `on_tool_call` for each invocation the model makes - there is no
        text-delta return channel in realtime mode, so this callback is the
        only way a realtime session can signal escalation."""
        ...

    async def send_tool_result(self, call_id: str | None, name: str, result: dict) -> None:
        """Feed a tool's result back into the live session and prompt the
        model to continue (each implementation's own vendor-shaped envelope,
        e.g. OpenAI's `conversation.item.create{type:"function_call_output"}`
        + `response.create`, or Gemini's `toolResponse.functionResponses[]`).
        Called by the runner from within (or shortly after) `on_tool_call`,
        using the same `call_id` the triggering `ToolCall` carried - or the
        runner's synthesized id when the vendor gave none. Implementations
        must no-op (log and return) if called before `run()` has established
        a live session, rather than raising."""
        ...

    async def update_session(self, instructions: str, tools: list[ToolSpec] | None) -> None:
        """Replace the live session's system instructions and tool set
        without tearing down the connection - the mechanism a workflow node
        transition uses to move a REALTIME call to a new node. Only
        implementations that support a genuine mid-session update (OpenAI
        Realtime's `session.update`) should do this for real; a provider
        that cannot (Gemini Live - `setup` is send-once) must document that
        limitation on its class and this method is simply never called for
        it (the workflow publish-time validator rejects the combination)."""
        ...


@runtime_checkable
class OutgoingAudioSink(Protocol):
    """Narrow interface the AudioSocket server hands to cascade/realtime
    providers so they can push audio out without depending on the paced
    player's full implementation."""

    def push(self, chunk: bytes) -> None: ...

    def barge_in_stop(self) -> None: ...


@dataclass
class ProviderLegConfig:
    """Generic per-leg config passed to provider factories - superset of the
    fields any provider might need, populated from `LegConfig` in
    config_client.py."""

    provider: str
    model: str
    api_key: str
    voice: str | None = None
    region: str | None = None
    base_url: str | None = None
    extra: dict = field(default_factory=dict)
