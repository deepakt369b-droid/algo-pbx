"""Human handoff: when the LLM/tools decide to transfer to a human, redirect
the live channel via AMI to the tenant's queue/extension
(`handoffExtensionHint` from AiAgentConfigResponse).

Mirrors the shape of algo-pbx-frontend's `src/lib/ami-client.ts` (the
existing Node AMI client used by `api/calls/conference/route.ts` etc.):
plain-text line-oriented protocol, blocks separated by `\\r\\n\\r\\n`,
`Action: Redirect` with `Channel`/`Context`/`Exten`/`Priority` fields, and the
same CR/LF header-injection guard on outgoing field values (that file's
comment explains why: AMI has no in-field escaping mechanism, so a value
containing CR/LF could smuggle in an entirely separate action).
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Optional

_FIELD_INJECTION_RE = None  # compiled lazily, see _assert_safe_field


def _assert_safe_field(name: str, value: str) -> None:
    global _FIELD_INJECTION_RE
    if _FIELD_INJECTION_RE is None:
        import re

        _FIELD_INJECTION_RE = re.compile(r"[\r\n]")
    if _FIELD_INJECTION_RE.search(value):
        raise ValueError(f"AMI action field '{name}' contains a CR/LF character - refusing to send (possible header injection).")


class AmiActionError(Exception):
    pass


@dataclass
class AmiClient:
    """Minimal asyncio AMI client - just enough for Login + Redirect, the
    handoff use case. Not a general-purpose AMI library."""

    host: str = None  # type: ignore[assignment]
    port: int = None  # type: ignore[assignment]
    username: str = None  # type: ignore[assignment]
    secret: str = None  # type: ignore[assignment]
    timeout_s: float = 5.0

    def __post_init__(self) -> None:
        self.host = self.host or os.environ.get("AMI_HOST", "127.0.0.1")
        self.port = self.port or int(os.environ.get("AMI_PORT", "5038"))
        self.username = self.username or os.environ.get("AMI_USERNAME", "algopbx-app")
        self.secret = self.secret if self.secret is not None else os.environ.get("AMI_SECRET", "")
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._action_id = 0

    async def connect(self) -> None:
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.port), timeout=self.timeout_s
        )
        # Consume the AMI greeting banner line (e.g. "Asterisk Call Manager/9.0.0\r\n").
        await asyncio.wait_for(self._reader.readline(), timeout=self.timeout_s)
        login_resp = await self.send({"Action": "Login", "Username": self.username, "Secret": self.secret})
        if login_resp.get("Response") != "Success":
            raise AmiActionError(f"AMI login failed: {login_resp.get('Message', 'unknown error')}")

    def _frame_action(self, fields: dict) -> tuple[str, bytes]:
        self._action_id += 1
        action_id = str(self._action_id)
        payload = {"ActionID": action_id, **fields}
        for key, value in payload.items():
            _assert_safe_field(key, str(value))
        lines = [f"{k}: {v}" for k, v in payload.items()]
        message = ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8")
        return action_id, message

    async def _read_block(self) -> dict:
        assert self._reader is not None
        lines: list[bytes] = []
        while True:
            line = await asyncio.wait_for(self._reader.readline(), timeout=self.timeout_s)
            if line in (b"\r\n", b""):
                break
            lines.append(line)
        block: dict = {}
        for raw_line in lines:
            text = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if ":" not in text:
                continue
            key, _, value = text.partition(":")
            block[key.strip()] = value.strip()
        return block

    async def send(self, fields: dict) -> dict:
        """Send an action and wait for its correlated response block. Does
        not attempt to correlate ActionID across interleaved unsolicited
        events (out of scope for the handoff-only use case here) - it
        assumes the next block read off the wire is the response, which
        holds for a single in-flight action on an otherwise idle connection."""
        assert self._writer is not None
        action_id, message = self._frame_action(fields)
        self._writer.write(message)
        await self._writer.drain()
        while True:
            block = await self._read_block()
            if block.get("ActionID") == action_id or "Response" in block:
                return block

    async def close(self) -> None:
        if self._writer is not None:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass
            self._writer = None
            self._reader = None


async def redirect_to_extension(
    *,
    channel: str,
    context: str,
    extension: str,
    priority: str = "1",
    client: Optional[AmiClient] = None,
) -> dict:
    """Redirect a live channel to `extension` in `context` - the human
    handoff action. `client` is injectable for tests; defaults to a fresh
    AmiClient built from AMI_HOST/AMI_PORT/AMI_USERNAME/AMI_SECRET env vars.
    """
    own_client = client is None
    ami = client or AmiClient()
    try:
        if own_client:
            await ami.connect()
        response = await ami.send(
            {
                "Action": "Redirect",
                "Channel": channel,
                "Context": context,
                "Exten": extension,
                "Priority": priority,
            }
        )
        if response.get("Response") == "Error":
            raise AmiActionError(f"AMI Redirect failed: {response.get('Message', 'unknown error')}")
        return response
    finally:
        if own_client:
            await ami.close()
