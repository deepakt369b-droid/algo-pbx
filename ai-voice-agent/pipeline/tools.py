"""The tools an AI agent may call for human escalation: shared by both
CASCADE (`pipeline/runner.py`'s `_run_cascade`, via `LlmProvider.generate`)
and REALTIME (`_run_realtime`, via `RealtimeProvider.run`'s `on_tool_call`)
so escalation behaves identically regardless of pipeline mode.

Kept as hardcoded ToolSpecs rather than something configurable per agent -
escalation is a fixed platform capability (see `ai-voice-agent/escalation.py`),
not something a tenant admin authors.

Two tools, not one, is what closes the "offer wait or callback" gap
escalation.py's own module docstring used to flag as open: rather than this
sidecar trying to parse a caller's freeform spoken answer to "would you like
to keep waiting, or should I arrange a callback?" with scripted logic, the
model itself is given a SECOND tool (REQUEST_CALLBACK) it can call in a
later turn once the caller answers - it already has to understand that
answer to keep the conversation coherent, so it is in the best position to
decide which tool (if either) applies, not a rigid parser here.
"""

from __future__ import annotations

from .base import ToolSpec

REQUEST_HUMAN_HANDOFF = "request_human_handoff"
REQUEST_CALLBACK = "request_callback"

REQUEST_HUMAN_HANDOFF_TOOL = ToolSpec(
    name=REQUEST_HUMAN_HANDOFF,
    description=(
        "Call this when the caller explicitly asks to speak with a human agent, "
        "or when you are unable to help them after a reasonable attempt. Do not "
        "call this for routine requests you can handle yourself."
    ),
    parameters={
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": "Brief reason a human is needed, e.g. 'caller requested a person' or 'unable to resolve billing dispute'.",
            },
            "caller_intent": {
                "type": "string",
                "description": "One-sentence summary of what the caller wants, to brief the human agent.",
            },
        },
        "required": ["reason"],
    },
)

REQUEST_CALLBACK_TOOL = ToolSpec(
    name=REQUEST_CALLBACK,
    description=(
        "Call this when a transfer to a human was not possible (you already told the "
        "caller so) and the caller says they would rather be called back than keep "
        "waiting or continue with you now. Only call this after the caller has clearly "
        "agreed to a callback, never as a first response."
    ),
    parameters={
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": "Brief note for whoever calls back, e.g. what the caller needs help with.",
            },
        },
        "required": [],
    },
)
