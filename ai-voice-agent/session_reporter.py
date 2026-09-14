"""Client for POST /api/internal/ai/sessions, matching the frozen
`AiSessionReportRequest` contract in algo-pbx-frontend/src/lib/ai/types.ts.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional

import httpx

Outcome = Literal["completed", "handed_off", "dropped", "error"]
Role = Literal["agent", "caller"]


@dataclass(frozen=True)
class TranscriptTurn:
    role: Role
    text: str
    at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {"role": self.role, "text": self.text, "at": self.at}


@dataclass
class SessionReport:
    """Mirrors `AiSessionReportRequest` field-for-field."""

    agent_id: str
    cdr_unique_id: str
    transcript: list[TranscriptTurn]
    outcome: Outcome
    summary: Optional[str] = None
    latency_ms_p50: Optional[float] = None
    latency_ms_p95: Optional[float] = None
    cost_tokens_input: Optional[int] = None
    cost_tokens_output: Optional[int] = None
    handoff_extension_id: Optional[str] = None

    def to_payload(self) -> dict:
        payload = {
            "agentId": self.agent_id,
            "cdrUniqueId": self.cdr_unique_id,
            "transcript": [turn.to_dict() for turn in self.transcript],
            "outcome": self.outcome,
        }
        if self.summary is not None:
            payload["summary"] = self.summary
        if self.latency_ms_p50 is not None:
            payload["latencyMsP50"] = self.latency_ms_p50
        if self.latency_ms_p95 is not None:
            payload["latencyMsP95"] = self.latency_ms_p95
        if self.cost_tokens_input is not None:
            payload["costTokensInput"] = self.cost_tokens_input
        if self.cost_tokens_output is not None:
            payload["costTokensOutput"] = self.cost_tokens_output
        if self.handoff_extension_id is not None:
            payload["handoffExtensionId"] = self.handoff_extension_id
        return payload


class SessionReportError(Exception):
    pass


@dataclass
class SessionReporter:
    base_url: str = field(default_factory=lambda: os.environ.get("NEXTJS_BASE_URL", "http://127.0.0.1:3000"))
    shared_secret: str = field(default_factory=lambda: os.environ.get("AI_SIDECAR_SHARED_SECRET", ""))
    timeout_s: float = 5.0

    async def report(self, report: SessionReport) -> None:
        url = f"{self.base_url.rstrip('/')}/api/internal/ai/sessions"
        headers = {
            "x-internal-secret": self.shared_secret,
            "content-type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(url, headers=headers, json=report.to_payload())
        except httpx.HTTPError as exc:
            raise SessionReportError(f"session report request failed: {exc}") from exc

        if resp.status_code >= 300:
            raise SessionReportError(f"session report returned HTTP {resp.status_code}: {resp.text[:500]}")
