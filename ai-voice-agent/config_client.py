"""Client for GET /api/internal/ai/agent-config, matching the frozen
`AiAgentConfigResponse` contract in algo-pbx-frontend/src/lib/ai/types.ts
(see .agents/hybrid-ai/contracts.md). This module must not drift from that
shape without a corresponding contract change on the Next.js side.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx


class ConfigFetchError(Exception):
    """Raised when the agent-config endpoint can't be reached or returns a
    non-2xx / malformed response."""


@dataclass(frozen=True)
class LegConfig:
    """One `realtime` / `stt` / `llm` / `tts` leg of AiAgentConfigResponse.

    `extra` carries anything not common to every provider (temperature,
    max_tokens, language, speed, ...) - see `ProviderLegConfig.extra` in
    pipeline/base.py, which this is forwarded into verbatim by
    `runner._leg_config()`. Until this field existed, `_leg_config()` had
    nothing to populate `ProviderLegConfig.extra` FROM, so it was always an
    empty dict in production regardless of what agent-config sent - a
    real bug, not a design choice (see LLM.md workflow-builder plan)."""

    provider: str
    model: str
    api_key: str
    voice: Optional[str] = None
    region: Optional[str] = None
    base_url: Optional[str] = None
    extra: dict = field(default_factory=dict)


@dataclass(frozen=True)
class VadConfig:
    """Interruption/VAD tunables - see pipeline/runner.py's
    voice_energy_threshold/end_of_utterance_silent_frames fields and
    audiosocket/protocol.py's BargeInDetector, which these override when
    present. Every field None means "use the sidecar's own hardcoded
    default" - unchanged behavior for every agent that predates this."""

    allow_interruption: bool = True
    energy_threshold: Optional[float] = None
    end_of_utterance_silent_frames: Optional[int] = None
    barge_in_threshold: Optional[float] = None
    barge_in_consecutive_frames: Optional[int] = None


@dataclass(frozen=True)
class AiAgentConfig:
    """Mirrors `AiAgentConfigResponse` field-for-field."""

    agent_id: str
    extension_number: str
    language: str
    greeting: str
    system_prompt: str
    pipeline_mode: str  # "REALTIME" | "CASCADE"
    realtime: Optional[LegConfig] = None
    stt: Optional[LegConfig] = None
    llm: Optional[LegConfig] = None
    tts: Optional[LegConfig] = None
    tools: Any = None
    outbound_enabled: bool = False
    handoff_extension_hint: Optional[str] = None
    # "SIMPLE" (default) - `workflow` is None and the cascade/realtime loop
    # drives the call purely off `system_prompt`, exactly as before these
    # fields existed. "WORKFLOW" with `workflow` populated - a node graph
    # drives the call instead, see pipeline/workflow.py. agent-config's own
    # route never sends promptMode="WORKFLOW" without a `workflow` block
    # (an unpublished draft resolves server-side to SIMPLE), but this module
    # doesn't trust that blindly - see pipeline/runner.py's `is_workflow`.
    prompt_mode: str = "SIMPLE"
    workflow: Any = None  # raw dict: {"version": int, "graph": {...}, "resolvedByNodeId": {...}}
    vad: VadConfig = field(default_factory=VadConfig)

    @property
    def is_realtime(self) -> bool:
        return self.pipeline_mode == "REALTIME"

    @property
    def is_workflow(self) -> bool:
        return self.prompt_mode == "WORKFLOW" and self.workflow is not None


def _parse_leg(raw: Optional[dict]) -> Optional[LegConfig]:
    if raw is None:
        return None
    # Only the fields a given leg kind actually carries appear in `raw` (a
    # `tts` leg has no "temperature", an `llm` leg has no "speed") - checking
    # generically here means this stays correct as agent-config/route.ts
    # gains fields without needing every leg-kind's shape hardcoded twice.
    extra: dict = {}
    if raw.get("temperature") is not None:
        extra["temperature"] = raw["temperature"]
    if raw.get("maxTokens") is not None:
        extra["max_tokens"] = raw["maxTokens"]
    if raw.get("language") is not None:
        extra["language"] = raw["language"]
    if raw.get("speed") is not None:
        extra["speed"] = raw["speed"]
    return LegConfig(
        provider=raw["provider"],
        model=raw["model"],
        api_key=raw["apiKey"],
        voice=raw.get("voice"),
        region=raw.get("region"),
        base_url=raw.get("baseUrl"),
        extra=extra,
    )


def _parse_vad(raw: Optional[dict]) -> VadConfig:
    if raw is None:
        return VadConfig()
    return VadConfig(
        allow_interruption=bool(raw.get("allowInterruption", True)),
        energy_threshold=raw.get("energyThreshold"),
        end_of_utterance_silent_frames=raw.get("endOfUtteranceSilentFrames"),
        barge_in_threshold=raw.get("bargeInThreshold"),
        barge_in_consecutive_frames=raw.get("bargeInConsecutiveFrames"),
    )


def parse_agent_config(payload: dict) -> AiAgentConfig:
    """Parse a raw JSON dict (as returned by the endpoint) into AiAgentConfig.
    Kept separate from the network call so unit tests can exercise parsing
    with a fixture dict, without mocking httpx."""
    return AiAgentConfig(
        agent_id=payload["agentId"],
        extension_number=payload["extensionNumber"],
        language=payload["language"],
        greeting=payload["greeting"],
        system_prompt=payload["systemPrompt"],
        pipeline_mode=payload["pipelineMode"],
        realtime=_parse_leg(payload.get("realtime")),
        stt=_parse_leg(payload.get("stt")),
        llm=_parse_leg(payload.get("llm")),
        tts=_parse_leg(payload.get("tts")),
        tools=payload.get("tools"),
        outbound_enabled=bool(payload.get("outboundEnabled", False)),
        handoff_extension_hint=payload.get("handoffExtensionHint"),
        prompt_mode=payload.get("promptMode", "SIMPLE"),
        workflow=payload.get("workflow"),
        vad=_parse_vad(payload.get("vad")),
    )


@dataclass
class ConfigClient:
    """Fetches agent config from the Next.js internal API.

    `base_url` defaults to env `NEXTJS_BASE_URL`; `shared_secret` defaults to
    env `AI_SIDECAR_SHARED_SECRET` and is sent as the `x-internal-secret`
    header per the contract.
    """

    base_url: str = field(default_factory=lambda: os.environ.get("NEXTJS_BASE_URL", "http://127.0.0.1:3000"))
    shared_secret: str = field(default_factory=lambda: os.environ.get("AI_SIDECAR_SHARED_SECRET", ""))
    timeout_s: float = 5.0

    async def fetch(self, *, extension: str, tenant_id: str) -> AiAgentConfig:
        url = f"{self.base_url.rstrip('/')}/api/internal/ai/agent-config"
        headers = {"x-internal-secret": self.shared_secret}
        params = {"ext": extension, "tenant": tenant_id}
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.get(url, headers=headers, params=params)
        except httpx.HTTPError as exc:
            raise ConfigFetchError(f"agent-config request failed: {exc}") from exc

        if resp.status_code != 200:
            raise ConfigFetchError(f"agent-config returned HTTP {resp.status_code}: {resp.text[:500]}")

        try:
            payload = resp.json()
        except ValueError as exc:
            raise ConfigFetchError(f"agent-config returned non-JSON body: {exc}") from exc

        try:
            return parse_agent_config(payload)
        except KeyError as exc:
            raise ConfigFetchError(f"agent-config payload missing field: {exc}") from exc
