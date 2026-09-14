"""AI -> human escalation orchestration client (LLM.md §34.2's plan,
Workstream B). Talks to Next.js's `POST /api/internal/ai/escalate`
(src/app/api/internal/ai/escalate/route.ts, Workstream C) for every AMI
action - this module, and everything under `pipeline/`, NEVER touch AMI
directly. The sidecar has no AMI credentials at all (see docker-compose.yml's
`ai-voice-agent` service, which never sets `AMI_*`), and even if it did,
`handoff.py`'s minimal AmiClient can only send one action and read one
response block - nowhere near enough for the CoreShowChannels/Originate/
waitForEvent sequence a real merge needs.

Node set (see the plan's own diagram):

    talking --(request_human_handoff)--> check (via /escalate "check")
                                              |
                    +-------------------------+
                    | unavailable              | available
                    v                          v
              speak apology              speak "one moment"
              (back to talking)          then merge (via /escalate "merge")
                                              |
                              +----------------+----------------+
                              | merge failed                    | merge succeeded
                              v                                  v
                        speak apology                    say nothing further -
                        (back to talking)                 caller has already been
                                                           AMI-Redirected out of
                                                           this connection; the
                                                           conference leg (a NEW
                                                           AudioSocket connection
                                                           resuming this session,
                                                           see main.py) picks up
                                                           the conversation.

The "offer wait or callback" step is handled via a SECOND tool
(request_callback, pipeline/tools.py) rather than scripted dialogue here:
after an unavailable/failed request_human_handoff, the AI apologizes and
keeps talking normally; if the caller then says they'd rather be called
back, the model calls request_callback itself in a later turn (it already
has to understand the caller's answer to stay coherent, so it is in the
best position to decide, not a rigid parser in this module) and
`request_callback()` below creates the CRM ContactTask
(src/app/api/internal/ai/escalate/route.ts's `callback` action).

KNOWN GAP for REALTIME mode: this controller's `speak()` callback is a no-op
there (see pipeline/runner.py's `_handle_tool_call`) - a realtime vendor
session (OpenAI Realtime / Gemini Live) owns its own audio pipeline
end-to-end, and neither provider adapter exposes a "say exactly this text"
hook independent of the model's own turn-taking. Escalation still WORKS in
REALTIME mode (the check/merge HTTP calls and the AMI-side merge are
identical regardless of pipeline mode), it just can't narrate its own
progress ("let me get a colleague") the way CASCADE mode does via TTS.
Equally not implemented: sending the vendor's own function-result event back
(e.g. OpenAI Realtime's `conversation.item.create` with
`type: function_call_output`) so the model knows the call resolved - a real
protocol gap, not silently pretended to be handled.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

import httpx

logger = logging.getLogger("ai-voice-agent.escalation")


class EscalationRequestError(Exception):
    """Raised when the /escalate HTTP call itself fails (network error, bad
    status) - distinct from a normal "unavailable"/"not merged" response,
    which is a successful call carrying a negative result."""


@dataclass
class EscalationOutcome:
    merged: bool
    reason: Optional[str] = None
    target_label: Optional[str] = None
    human_answered: Optional[bool] = None


# Every substantive apology invites a callback (request_callback,
# pipeline/tools.py) - this is what actually surfaces the offer to the
# caller; the tool being available to the model isn't enough on its own if
# the model is never prompted to mention it.
_CALLBACK_INVITE = " I can also arrange for someone to call you back, if you'd prefer."

# Caller-facing prompts for each reason escalate/route.ts's `check`/`merge`
# can return. A dict rather than an if/elif chain so a new reason added on
# the Next.js side degrades to the generic fallback instead of a KeyError
# taking down the call.
_UNAVAILABLE_MESSAGES: dict[str, str] = {
    "escalation_disabled": "I'm not able to transfer you to someone right now, but let me keep helping." + _CALLBACK_INVITE,
    "no_target_configured": "I don't have anyone to transfer you to right now, but let me keep helping." + _CALLBACK_INVITE,
    "gsm_capacity": "I'm not able to reach a colleague by phone right now - every line is busy." + _CALLBACK_INVITE,
    "call_not_found": "Something went wrong on my end trying to reach a colleague. Let me keep helping." + _CALLBACK_INVITE,
    "agent_not_found": "Something went wrong on my end trying to reach a colleague. Let me keep helping." + _CALLBACK_INVITE,
    "agent_extension_missing": "Something went wrong on my end trying to reach a colleague. Let me keep helping." + _CALLBACK_INVITE,
    "ai_leg_originate_failed": "I couldn't set up the transfer just now." + _CALLBACK_INVITE,
    "ai_leg_join_timeout": "I couldn't set up the transfer just now." + _CALLBACK_INVITE,
    "check_request_failed": "Something went wrong on my end trying to reach a colleague. Let me keep helping." + _CALLBACK_INVITE,
    "merge_request_failed": "Something went wrong on my end trying to reach a colleague. Let me keep helping." + _CALLBACK_INVITE,
    "compliance_denied": "I'm not able to make that transfer right now, but let me keep helping." + _CALLBACK_INVITE,
    # The caller hung up mid-attempt (escalate/route.ts's "caller_hung_up") -
    # there is no one left to apologize to, let alone offer a callback.
    "caller_hung_up": "",
}
_DEFAULT_UNAVAILABLE_MESSAGE = "I'm not able to transfer you right now, but let me keep helping." + _CALLBACK_INVITE

# Caller-facing prompts for a request_callback attempt's own outcome.
_CALLBACK_UNAVAILABLE_MESSAGES: dict[str, str] = {
    "agent_not_found": "Sorry, I wasn't able to arrange that callback. Let me keep helping.",
    "call_not_found": "Sorry, I wasn't able to arrange that callback. Let me keep helping.",
    "caller_number_unknown": "Sorry, I don't have a number to call you back on. Let me keep helping.",
    "no_assignee_available": "Sorry, I wasn't able to arrange that callback right now. Let me keep helping.",
    "callback_request_failed": "Sorry, I wasn't able to arrange that callback. Let me keep helping.",
}
_DEFAULT_CALLBACK_UNAVAILABLE_MESSAGE = "Sorry, I wasn't able to arrange that callback. Let me keep helping."
_CALLBACK_SUCCESS_MESSAGE = "Done - someone will call you back soon."


@dataclass
class CallbackOutcome:
    created: bool
    reason: Optional[str] = None
    task_id: Optional[str] = None


@dataclass
class EscalationClient:
    """Thin HTTP client for POST /api/internal/ai/escalate. Kept separate
    from EscalationController below so the controller's flow/speak logic is
    unit-testable against a fake client, without mocking httpx."""

    base_url: str = field(default_factory=lambda: os.environ.get("NEXTJS_BASE_URL", "http://127.0.0.1:3000"))
    shared_secret: str = field(default_factory=lambda: os.environ.get("AI_SIDECAR_SHARED_SECRET", ""))
    timeout_s: float = 30.0

    async def _post(self, body: dict) -> dict:
        url = f"{self.base_url.rstrip('/')}/api/internal/ai/escalate"
        headers = {"x-internal-secret": self.shared_secret, "content-type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise EscalationRequestError(f"escalate request failed: {exc}") from exc
        if resp.status_code != 200:
            raise EscalationRequestError(f"escalate returned HTTP {resp.status_code}: {resp.text[:500]}")
        try:
            return resp.json()
        except ValueError as exc:
            raise EscalationRequestError(f"escalate returned non-JSON body: {exc}") from exc

    async def check(self, *, agent_id: str, call_uuid: str) -> dict:
        return await self._post({"action": "check", "agentId": agent_id, "callUuid": call_uuid})

    async def merge(self, *, agent_id: str, call_uuid: str) -> dict:
        return await self._post({"action": "merge", "agentId": agent_id, "callUuid": call_uuid})

    async def callback(self, *, agent_id: str, call_uuid: str, reason: Optional[str] = None) -> dict:
        body: dict = {"action": "callback", "agentId": agent_id, "callUuid": call_uuid}
        if reason:
            body["reason"] = reason
        return await self._post(body)


@dataclass
class EscalationController:
    """Owns the escalation flow for one `request_human_handoff` tool call.
    `speak` is a caller-supplied async callback (bound to the pipeline's own
    TTS in CASCADE mode, a no-op in REALTIME - see pipeline/runner.py)
    rather than this module driving audio directly, so this class has zero
    AudioSocket/TTS-provider dependencies of its own and is trivially
    unit-testable with a fake speak() and a fake EscalationClient."""

    agent_id: str
    call_uuid: str
    speak: Callable[[str], Awaitable[None]]
    client: EscalationClient = field(default_factory=EscalationClient)

    async def request_handoff(self, reason: str) -> EscalationOutcome:
        await self.speak("Let me get a colleague on the line, one moment.")

        try:
            check = await self.client.check(agent_id=self.agent_id, call_uuid=self.call_uuid)
        except EscalationRequestError:
            logger.exception("escalate check request failed for call %s", self.call_uuid)
            return await self._unavailable("check_request_failed")

        if not check.get("available"):
            return await self._unavailable(check.get("reason"))

        try:
            merge = await self.client.merge(agent_id=self.agent_id, call_uuid=self.call_uuid)
        except EscalationRequestError:
            logger.exception("escalate merge request failed for call %s", self.call_uuid)
            return await self._unavailable("merge_request_failed")

        if not merge.get("merged"):
            return await self._unavailable(merge.get("reason"))

        logger.info(
            "Escalation merged for call %s -> %s (human_answered=%s)",
            self.call_uuid,
            merge.get("targetLabel"),
            merge.get("humanAnswered"),
        )
        # Nothing left to speak: the caller has ALREADY been AMI-Redirected
        # out of this AudioSocket connection by the time the HTTP call
        # above returned. The conference leg - a NEW AudioSocket connection
        # resuming this session (main.py's LiveSession/resume_of handling)
        # - picks up the conversation from here.
        return EscalationOutcome(merged=True, target_label=merge.get("targetLabel"), human_answered=merge.get("humanAnswered"))

    async def _unavailable(self, reason: Optional[str]) -> EscalationOutcome:
        logger.info("Escalation unavailable for call %s: %s", self.call_uuid, reason)
        message = _UNAVAILABLE_MESSAGES.get(reason or "", _DEFAULT_UNAVAILABLE_MESSAGE)
        if message:
            await self.speak(message)
        return EscalationOutcome(merged=False, reason=reason)

    async def request_callback(self, reason: str) -> CallbackOutcome:
        """The caller's answer to the "would you like a callback?" question
        the last _unavailable() apology invited - see this module's
        docstring for why that's modeled as a second tool call rather than
        scripted parsing of the caller's spoken response."""
        try:
            result = await self.client.callback(agent_id=self.agent_id, call_uuid=self.call_uuid, reason=reason or None)
        except EscalationRequestError:
            logger.exception("escalate callback request failed for call %s", self.call_uuid)
            return await self._callback_unavailable("callback_request_failed")

        if not result.get("created"):
            return await self._callback_unavailable(result.get("reason"))

        logger.info("Callback task created for call %s -> task %s", self.call_uuid, result.get("taskId"))
        await self.speak(_CALLBACK_SUCCESS_MESSAGE)
        return CallbackOutcome(created=True, task_id=result.get("taskId"))

    async def _callback_unavailable(self, reason: Optional[str]) -> CallbackOutcome:
        logger.info("Callback unavailable for call %s: %s", self.call_uuid, reason)
        message = _CALLBACK_UNAVAILABLE_MESSAGES.get(reason or "", _DEFAULT_CALLBACK_UNAVAILABLE_MESSAGE)
        await self.speak(message)
        return CallbackOutcome(created=False, reason=reason)
