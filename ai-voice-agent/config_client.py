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
    """One `realtime` / `stt` / `llm` / `tts` leg of AiAgentConfigResponse."""

    provider: str
    model: str
    api_key: str
    voice: Optional[str] = None
    region: Optional[str] = None
    base_url: Optional[str] = None


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

    @property
    def is_realtime(self) -> bool:
        return self.pipeline_mode == "REALTIME"


def _parse_leg(raw: Optional[dict]) -> Optional[LegConfig]:
    if raw is None:
        return None
    return LegConfig(
        provider=raw["provider"],
        model=raw["model"],
        api_key=raw["apiKey"],
        voice=raw.get("voice"),
        region=raw.get("region"),
        base_url=raw.get("baseUrl"),
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
