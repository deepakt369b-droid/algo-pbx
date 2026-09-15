"""Thin HTTP client for POST /api/internal/ai/http-tool - the ONLY place an
HTTP_TOOL workflow node's actual outbound request happens. This sidecar runs
`network_mode: host` (docker-compose.yml), so letting it fetch an
tenant-authored URL directly would be a materially worse SSRF position than
the one already fixed for provider baseUrls in §34 - the request happens in
Next.js instead, which re-reads the node from the PUBLISHED workflow version
(never trusting a URL this sidecar might send), resolves `{{secrets.NAME}}`
server-side, and enforces `assertPublicHttpUrl()` before dispatching. This
module never sees the URL/headers/body itself - it only tells Next.js WHICH
node to run, by id, exactly mirroring EscalationClient's shape in
escalation.py (same base_url/shared_secret env vars, same error type
convention) so a reader already familiar with that module recognizes this one
immediately.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

import httpx


class HttpToolRequestError(Exception):
    """Raised when the http-tool endpoint can't be reached or returns a
    non-2xx / malformed response."""


@dataclass
class HttpToolClient:
    base_url: str = field(default_factory=lambda: os.environ.get("NEXTJS_BASE_URL", "http://127.0.0.1:3000"))
    shared_secret: str = field(default_factory=lambda: os.environ.get("AI_SIDECAR_SHARED_SECRET", ""))
    timeout_s: float = 15.0

    async def call(self, *, agent_id: str, node_id: str, gathered_context: Optional[dict] = None) -> dict:
        """Returns `{"ok": bool, "extracted": {var: value, ...}, "error"?: str}`
        - `extracted` maps straight into the runner's gathered_context on
        success; a non-ok result is fed back to the model as a tool result
        too (so it can tell the caller the lookup failed), never raised past
        this call site into a hung turn.

        `gathered_context` is sent along (not just agent_id/node_id) because
        the node's URL/header/body templates may reference
        `{{gathered_context.X}}` values collected by an earlier AGENT node's
        record_info call - the server can't render those without seeing the
        current values. This sidecar never sees or constructs the actual
        URL/headers/body itself (see the module docstring) - it only
        supplies the data the server-side template renderer needs."""
        url = f"{self.base_url.rstrip('/')}/api/internal/ai/http-tool"
        headers = {"x-internal-secret": self.shared_secret, "content-type": "application/json"}
        body = {"agentId": agent_id, "nodeId": node_id, "gatheredContext": gathered_context or {}}
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise HttpToolRequestError(f"http-tool request failed: {exc}") from exc
        if resp.status_code != 200:
            raise HttpToolRequestError(f"http-tool returned HTTP {resp.status_code}: {resp.text[:500]}")
        try:
            return resp.json()
        except ValueError as exc:
            raise HttpToolRequestError(f"http-tool returned non-JSON body: {exc}") from exc
