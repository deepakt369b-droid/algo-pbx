"""Entrypoint: starts the HTTP pre-registration server (port 9091) and the
AudioSocket TCP server (port 9092).

Call flow:
  1. The Asterisk dialplan, before invoking `AudioSocket()`, POSTs a
     pre-registration to this sidecar's HTTP server on 9091 with the call's
     UUID (the same UUID it will pass to `AudioSocket(<uuid>,127.0.0.1:9092)`),
     the extension being called, and the tenant ID. This lets the sidecar
     fetch AiAgentConfigResponse and have it ready *before* the AudioSocket
     TCP connection arrives, avoiding first-frame latency.
  2. Asterisk then connects to 9092 and the AudioSocket protocol begins: the
     first frame is a UUID frame (see audiosocket/protocol.py) that the
     sidecar uses to look up the pre-registration from step 1.
  3. Audio frames flow bidirectionally until a HANGUP frame or TCP close.

ASSUMPTION: the exact pre-registration HTTP request shape (path, method,
field names) is not specified anywhere the task's contracts.md pins down -
only that "the dialplan/AudioSocket setup can hit it to register an upcoming
call by UUID+extension+tenant". This implementation exposes
`POST /register` with JSON body `{"call_uuid", "extension", "tenant_id"}`;
if W5 (config) wires a different shape, only `PreRegistrationServer.handle_register`
needs to change.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid as uuid_module
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

from audiosocket.protocol import (
    BargeInDetector,
    FrameDecoderStream,
    FrameType,
    PacedPlayer,
    encode_frame,
)
from config_client import AiAgentConfig, ConfigClient
from pipeline.runner import PipelineRunner, PlayerAudioSink
from session_reporter import SessionReport, SessionReporter, TranscriptTurn

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("ai-voice-agent")

# Both servers are only ever reached by Asterisk on this same host (see
# extensions.conf's AudioSocket(${UNIQUEID},127.0.0.1:9092) and the CURL()
# pre-registration call added alongside it) — the default bind host is
# loopback-only. `network_mode: host` in docker-compose.yml means a
# 0.0.0.0 default here would otherwise be reachable from the public
# internet with zero compensating control (finding #2, post-verification
# fix round). Still overridable via env for anyone with a real reason to.
AUDIOSOCKET_HOST = os.environ.get("AUDIOSOCKET_HOST", "127.0.0.1")
AUDIOSOCKET_PORT = int(os.environ.get("AUDIOSOCKET_PORT", "9092"))
PREREG_HOST = os.environ.get("PREREG_HOST", "127.0.0.1")
PREREG_PORT = int(os.environ.get("PREREG_PORT", "9091"))

# Same shared secret already used outbound to Next.js (config_client.py,
# session_reporter.py) — reused here so the dialplan's CURL() pre-registration
# call and the sidecar's own outbound calls authenticate with the exact same
# value. Fails CLOSED if unset (never authenticates any request), matching
# src/app/api/internal/ai/_auth.ts's isAuthorizedInternalAiRequest pattern on
# the Next.js side.
AI_SIDECAR_SHARED_SECRET = os.environ.get("AI_SIDECAR_SHARED_SECRET", "")


def _is_authorized_prereg_request(headers: dict[str, str]) -> bool:
    """Mirrors src/app/api/internal/ai/_auth.ts's fail-closed behavior: an
    unset shared secret means NO request is ever authorized, not "allow
    all". Plain (non-constant-time) comparison is acceptable here — unlike
    the Next.js side (reachable from the internet before this fix), this
    endpoint is now loopback-only and hit only by Asterisk's CURL()."""
    if not AI_SIDECAR_SHARED_SECRET:
        return False
    provided = headers.get("x-internal-secret", "")
    return provided == AI_SIDECAR_SHARED_SECRET


@dataclass
class PendingCall:
    call_uuid: str
    extension: str
    tenant_id: str
    registered_at: float = field(default_factory=time.monotonic)
    # AI -> human escalation session continuity (LLM.md §34.2's plan,
    # Workstream B). Set only by the CURL() pre-registration
    # [ai-conference-leg] issues for a resumed conference leg
    # (pbx_configs/extensions.conf) - `.get()`'d rather than required so the
    # existing [ai-agent-internal]/[from-dinstar-ai] CURL() bodies (which
    # never send these fields) keep working unchanged.
    resume_of: Optional[str] = None
    role: str = "primary"


# How long a /register entry may sit unclaimed before AudioSocketServer's
# reaper drops it (see _reap_stale_registrations). Generous relative to how
# fast Asterisk actually connects after CURL() returns (sub-second in
# practice) - this exists to bound a leak, not to police normal latency.
PENDING_CALL_TTL_S = 60.0
PENDING_CALL_REAP_INTERVAL_S = 30.0


@dataclass
class LiveSession:
    """A call's conversation state, kept alive across an AudioSocket leg
    swap during an AI -> human escalation. Created by the ORIGINAL
    connection when it first fetches AiAgentConfig; looked up by a RESUMED
    connection (PendingCall.resume_of) so the conference leg continues the
    SAME conversation instead of starting fresh. Never re-keyed - always
    stored under `original_call_uuid`, which is also what session reporting
    uses for `cdr_unique_id` regardless of which leg does the reporting, so
    AiCallSession.cdrUniqueId keeps matching CallDetailRecord.uniqueId and
    the ${UNIQUEID}.wav recording filename."""

    config: AiAgentConfig
    transcript: list[TranscriptTurn]
    original_call_uuid: str
    # Set by a resumed connection to ITS OWN call_uuid once it successfully
    # takes over - read by the ORIGINAL connection's `finally` to know it
    # must skip reporting (the resumed leg now owns that). None means no
    # resume has happened (yet, or ever, if the call just ends normally).
    migrated_to: Optional[str] = None
    # Set once an escalation on this session actually merges - read by the
    # resumed leg's `finally` for SessionReport.handoff_extension_id.
    handoff_target_label: Optional[str] = None
    # The ORIGINAL connection sets this in its own `finally` once its
    # AudioSocket connection has fully torn down - a RESUMED connection
    # waits on it (bounded, see PipelineRunner start below) before
    # start()ing its own runner, so the two connections' TTS/realtime audio
    # never overlap even though both may be briefly alive at once (the
    # resumed leg's UUID frame typically arrives, and is processed, BEFORE
    # the original leg's Redirect-triggered teardown runs).
    ready_event: asyncio.Event = field(default_factory=asyncio.Event)


class PreRegistrationServer:
    """Tiny HTTP/1.1 server (stdlib-only, no framework) for the one
    `POST /register` endpoint. A full ASGI app would be overkill for a
    single internal endpoint hit only by the local dialplan/config layer."""

    def __init__(self, registry: dict[str, PendingCall]) -> None:
        self._registry = registry
        self._server: Optional[asyncio.base_events.Server] = None

    async def start(self, host: str = PREREG_HOST, port: int = PREREG_PORT) -> None:
        self._server = await asyncio.start_server(self._handle_client, host, port)
        logger.info("Pre-registration HTTP server listening on %s:%s", host, port)

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await reader.readline()
            if not request_line:
                return
            method, path, _ = request_line.decode("utf-8", errors="replace").split(" ", 2)
            headers: dict[str, str] = {}
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b""):
                    break
                text = line.decode("utf-8", errors="replace").rstrip("\r\n")
                if ":" in text:
                    k, _, v = text.partition(":")
                    headers[k.strip().lower()] = v.strip()

            body = b""
            content_length = int(headers.get("content-length", "0") or "0")
            if content_length:
                body = await reader.readexactly(content_length)

            status, response_body = self._route(method, path, headers, body)
            response = (
                f"HTTP/1.1 {status}\r\n"
                f"Content-Type: application/json\r\n"
                f"Content-Length: {len(response_body)}\r\n"
                f"Connection: close\r\n\r\n"
            ).encode("utf-8") + response_body
            writer.write(response)
            await writer.drain()
        except Exception:
            logger.exception("Error handling pre-registration HTTP request")
        finally:
            writer.close()

    def _route(self, method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[str, bytes]:
        if method == "POST" and path.rstrip("/") == "/register":
            if not _is_authorized_prereg_request(headers):
                logger.warning("Rejected unauthorized pre-registration request")
                return "401 Unauthorized", b'{"error":"unauthorized"}'
            return self.handle_register(body)
        return "404 Not Found", b'{"error":"not found"}'

    def handle_register(self, body: bytes) -> tuple[str, bytes]:
        try:
            payload = json.loads(body or b"{}")
            call_uuid = str(payload["call_uuid"])
            extension = str(payload["extension"])
            tenant_id = str(payload["tenant_id"])
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            return "400 Bad Request", json.dumps({"error": f"invalid pre-registration body: {exc}"}).encode()

        resume_of = payload.get("resume_of")
        role = str(payload.get("role") or "primary")
        self._registry[call_uuid] = PendingCall(
            call_uuid=call_uuid,
            extension=extension,
            tenant_id=tenant_id,
            resume_of=str(resume_of) if resume_of else None,
            role=role,
        )
        logger.info(
            "Pre-registered call %s ext=%s tenant=%s role=%s resume_of=%s",
            call_uuid, extension, tenant_id, role, resume_of,
        )
        return "200 OK", json.dumps({"status": "registered"}).encode()


class AudioSocketServer:
    """Binary AudioSocket TCP server on port 9092. One connection per call."""

    def __init__(self, registry: dict[str, PendingCall], config_client: ConfigClient, session_reporter: SessionReporter) -> None:
        self._registry = registry
        self._config_client = config_client
        self._session_reporter = session_reporter
        self._server: Optional[asyncio.base_events.Server] = None
        # Keyed by original_call_uuid - see LiveSession's own docstring.
        self._sessions: dict[str, LiveSession] = {}

    async def start(self, host: str = AUDIOSOCKET_HOST, port: int = AUDIOSOCKET_PORT) -> None:
        self._server = await asyncio.start_server(self._handle_connection, host, port)
        logger.info("AudioSocket TCP server listening on %s:%s", host, port)

    async def _handle_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        logger.info("AudioSocket connection from %s", peer)
        decoder = FrameDecoderStream()
        call_uuid: Optional[str] = None
        pending: Optional[PendingCall] = None
        config: Optional[AiAgentConfig] = None
        transcript: list[TranscriptTurn] = []
        barge_in = BargeInDetector()
        player = PacedPlayer()
        bot_speaking = False
        runner: Optional[PipelineRunner] = None
        # AI -> human escalation session continuity (LiveSession's own
        # docstring has the full picture). `live_session` is set either when
        # THIS connection creates a fresh session (normal call) or when it
        # resumes an existing one (a conference leg); `is_resumed_leg`
        # distinguishes which, since both cases end up with a non-None
        # `live_session` but owe very different behavior in `finally` below.
        live_session: Optional[LiveSession] = None
        is_resumed_leg = False

        def send_audio(payload: bytes) -> None:
            writer.write(encode_frame(FrameType.SLIN, payload))

        def set_bot_speaking(value: bool) -> None:
            nonlocal bot_speaking
            bot_speaking = value

        player_task = asyncio.create_task(player.run(send_audio))

        try:
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                for frame in decoder.feed(chunk):
                    if frame.type == FrameType.UUID:
                        call_uuid = str(uuid_module.UUID(bytes=frame.payload)) if len(frame.payload) == 16 else frame.payload.decode(errors="replace")
                        pending = self._registry.pop(call_uuid, None)
                        if pending is None:
                            logger.warning("AudioSocket call %s arrived with no pre-registration", call_uuid)
                            continue

                        resume_context: Optional[str] = None
                        skip_greeting = False

                        if pending.resume_of and pending.resume_of in self._sessions:
                            # RESUMED conference leg (LiveSession's own
                            # docstring). Reuse the original session's
                            # config/transcript rather than fetching fresh -
                            # one less network hop, and guarantees identical
                            # config to what the caller has been hearing.
                            live_session = self._sessions[pending.resume_of]
                            is_resumed_leg = True
                            config = live_session.config
                            transcript = live_session.transcript
                            live_session.migrated_to = call_uuid
                            resume_context = (
                                "You are now in a 3-way conference with the caller and a human "
                                "colleague who has just joined. Briefly introduce the caller's "
                                "issue to your colleague, then stay mostly quiet and let them talk."
                            )
                            skip_greeting = True
                            # Bounded wait for the ORIGINAL connection to
                            # finish tearing down (its own `finally` sets
                            # this) before this leg starts speaking - avoids
                            # both connections' TTS/realtime audio
                            # overlapping. 10s is generous: in the normal
                            # merge flow the original leg's AudioSocket app
                            # is interrupted by the AMI Redirect almost
                            # immediately after this connection arrives.
                            try:
                                await asyncio.wait_for(live_session.ready_event.wait(), timeout=10.0)
                            except asyncio.TimeoutError:
                                logger.warning(
                                    "Conference leg for call %s (resume_of=%s) timed out waiting for the "
                                    "original leg to finish tearing down - proceeding anyway",
                                    call_uuid, pending.resume_of,
                                )
                        elif pending.resume_of:
                            # resume_of was set but no matching LiveSession
                            # exists (already cleaned up, or a bug) - fall
                            # back to a normal fresh-call fetch rather than
                            # failing the connection outright.
                            logger.warning(
                                "Call %s registered with resume_of=%s but no matching session was found - "
                                "treating as a fresh call", call_uuid, pending.resume_of,
                            )

                        if live_session is None:
                            try:
                                config = await self._config_client.fetch(
                                    extension=pending.extension, tenant_id=pending.tenant_id
                                )
                            except Exception:
                                logger.exception("Failed to fetch agent config for call %s", call_uuid)
                                continue
                            live_session = LiveSession(config=config, transcript=transcript, original_call_uuid=call_uuid)
                            self._sessions[call_uuid] = live_session

                        if config.greeting and config.is_realtime and not skip_greeting:
                            # Cascade mode speaks (and records) the greeting
                            # itself via TTS - see PipelineRunner._run_cascade.
                            # Realtime mode has no separate greeting-playback
                            # step (the vendor session decides when to speak
                            # first; see runner.py's module docstring), so
                            # just log it to the transcript for now.
                            transcript.append(TranscriptTurn(role="agent", text=config.greeting))
                        runner = PipelineRunner(
                            config=config,
                            audio_sink=PlayerAudioSink(player, set_bot_speaking),
                            transcript=transcript,
                            set_bot_speaking=set_bot_speaking,
                            call_uuid=call_uuid,
                            resume_context=resume_context,
                            skip_greeting=skip_greeting,
                        )
                        runner.start()
                    elif frame.type == FrameType.SLIN:
                        if barge_in.observe(frame.payload, bot_speaking=bot_speaking):
                            player.flush()
                            bot_speaking = False
                        if runner is not None:
                            runner.push_audio(frame.payload)
                    elif frame.type == FrameType.DTMF:
                        logger.debug("DTMF %s on call %s", frame.payload, call_uuid)
                    elif frame.type == FrameType.HANGUP:
                        raise _Hangup()
                    elif frame.type == FrameType.ERROR:
                        logger.warning("AudioSocket ERROR frame on call %s: %r", call_uuid, frame.payload)
        except _Hangup:
            pass
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        finally:
            if runner is not None:
                await runner.stop()
                if runner.escalation_outcome is not None and runner.escalation_outcome.merged and live_session is not None:
                    live_session.handoff_target_label = runner.escalation_outcome.target_label
                elif runner.escalation_request is not None:
                    # A handoff was requested but did not merge (blocked or
                    # failed) - already logged with the specific reason
                    # inside escalation.py's EscalationController; this is
                    # just a connection-level breadcrumb.
                    logger.info("Call %s's escalation attempt did not result in a merge", call_uuid)
            player.stop()
            player_task.cancel()
            writer.close()

            # Session-reporting ownership (LiveSession's own docstring has
            # the full reasoning): a resumed leg ALWAYS reports (it's the
            # final leg of the call); an original leg reports UNLESS another
            # leg has since resumed it (migrated_to set), in which case that
            # leg owns reporting instead - never both, never neither.
            if config is not None and call_uuid is not None:
                if is_resumed_leg and live_session is not None:
                    await self._report_session(
                        config,
                        live_session.original_call_uuid,
                        transcript,
                        outcome="handed_off",
                        handoff_extension_id=live_session.handoff_target_label,
                    )
                elif live_session is None or live_session.migrated_to is None:
                    await self._report_session(config, call_uuid, transcript)
                # else: this original leg was resumed by another leg, which
                # owns reporting - skip.

            if live_session is not None:
                live_session.ready_event.set()
                if is_resumed_leg or live_session.migrated_to is None:
                    # Terminal for this session either way: a resumed leg is
                    # never itself resumed again (no chained second
                    # escalation supported), and an original leg that never
                    # migrated is simply done.
                    self._sessions.pop(live_session.original_call_uuid, None)

            logger.info("AudioSocket connection closed for call %s", call_uuid)

    async def _report_session(
        self,
        config: AiAgentConfig,
        call_uuid: str,
        transcript: list[TranscriptTurn],
        *,
        outcome: str = "completed",
        handoff_extension_id: Optional[str] = None,
    ) -> None:
        report = SessionReport(
            agent_id=config.agent_id,
            cdr_unique_id=call_uuid,
            transcript=transcript,
            outcome=outcome,
            handoff_extension_id=handoff_extension_id,
        )
        try:
            await self._session_reporter.report(report)
        except Exception:
            logger.exception("Failed to report AI session for call %s", call_uuid)


class _Hangup(Exception):
    pass


async def _reap_stale_registrations(registry: dict[str, PendingCall]) -> None:
    """Pre-existing leak, fixed as part of the AI -> human escalation work
    (LLM.md §34.2's plan): PendingCall.registered_at was set and never read,
    so a `/register` with no matching AudioSocket connection ever arriving
    (e.g. the Originate that was supposed to trigger it fails) leaked
    forever. This became load-bearing rather than theoretical once
    escalate/route.ts started pre-registering a conference leg BEFORE an
    Originate that can fail (ai_leg_originate_failed/ai_leg_join_timeout) -
    every one of those failure paths would otherwise leak one entry."""
    while True:
        await asyncio.sleep(PENDING_CALL_REAP_INTERVAL_S)
        now = time.monotonic()
        stale = [uuid for uuid, pending in registry.items() if now - pending.registered_at > PENDING_CALL_TTL_S]
        for uuid in stale:
            pending = registry.pop(uuid, None)
            if pending is not None:
                logger.warning(
                    "Reaped stale pre-registration for call %s (ext=%s, registered %.0fs ago, never connected)",
                    uuid, pending.extension, now - pending.registered_at,
                )


async def amain() -> None:
    registry: dict[str, PendingCall] = {}
    config_client = ConfigClient()
    session_reporter = SessionReporter()

    prereg = PreRegistrationServer(registry)
    audiosocket = AudioSocketServer(registry, config_client, session_reporter)

    await prereg.start()
    await audiosocket.start()
    asyncio.create_task(_reap_stale_registrations(registry))

    # Run forever.
    await asyncio.Event().wait()


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
