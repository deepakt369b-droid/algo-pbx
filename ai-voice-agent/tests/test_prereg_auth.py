"""Post-verification fix round tests:
  - PreRegistrationServer.handle_register requires the x-internal-secret
    header to match AI_SIDECAR_SHARED_SECRET (finding #2).
  - The shared secret env var fails closed when unset (matches
    src/app/api/internal/ai/_auth.ts's isAuthorizedInternalAiRequest).
  - AUDIOSOCKET_HOST/PREREG_HOST default to 127.0.0.1, not 0.0.0.0.
"""

import importlib
import json

import main as main_module


def _reload_main(monkeypatch, secret=None, **env):
    """Reload main.py with a controlled environment so its module-level
    AI_SIDECAR_SHARED_SECRET / AUDIOSOCKET_HOST / PREREG_HOST constants
    (computed once at import time from os.environ) reflect the test's
    desired env, rather than whatever the running interpreter's environ
    happens to hold."""
    if secret is None:
        monkeypatch.delenv("AI_SIDECAR_SHARED_SECRET", raising=False)
    else:
        monkeypatch.setenv("AI_SIDECAR_SHARED_SECRET", secret)
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    return importlib.reload(main_module)


def test_default_bind_hosts_are_loopback_not_all_interfaces(monkeypatch):
    monkeypatch.delenv("AUDIOSOCKET_HOST", raising=False)
    monkeypatch.delenv("PREREG_HOST", raising=False)
    mod = importlib.reload(main_module)
    try:
        assert mod.AUDIOSOCKET_HOST == "127.0.0.1"
        assert mod.PREREG_HOST == "127.0.0.1"
        assert mod.AUDIOSOCKET_HOST != "0.0.0.0"
        assert mod.PREREG_HOST != "0.0.0.0"
    finally:
        importlib.reload(main_module)


def test_bind_hosts_still_overridable_via_env(monkeypatch):
    mod = _reload_main(monkeypatch, AUDIOSOCKET_HOST="10.0.0.5", PREREG_HOST="10.0.0.6")
    try:
        assert mod.AUDIOSOCKET_HOST == "10.0.0.5"
        assert mod.PREREG_HOST == "10.0.0.6"
    finally:
        importlib.reload(main_module)


def _register_body():
    return json.dumps({"call_uuid": "abc-123", "extension": "2001", "tenant_id": "tenant-1"}).encode()


def test_register_rejected_when_secret_header_missing(monkeypatch):
    mod = _reload_main(monkeypatch, secret="s3cret")
    try:
        server = mod.PreRegistrationServer({})
        status, body = server._route("POST", "/register", {}, _register_body())
        assert status == "401 Unauthorized"
        assert b"unauthorized" in body
        assert server._registry == {}
    finally:
        importlib.reload(main_module)


def test_register_rejected_when_secret_header_wrong(monkeypatch):
    mod = _reload_main(monkeypatch, secret="s3cret")
    try:
        server = mod.PreRegistrationServer({})
        status, _ = server._route(
            "POST", "/register", {"x-internal-secret": "wrong"}, _register_body()
        )
        assert status == "401 Unauthorized"
        assert server._registry == {}
    finally:
        importlib.reload(main_module)


def test_register_rejected_when_secret_env_unset_even_with_matching_header(monkeypatch):
    # Fail-closed: an empty configured secret must never authenticate any
    # request, even one that happens to send an empty/blank header.
    mod = _reload_main(monkeypatch, secret=None)
    try:
        server = mod.PreRegistrationServer({})
        status, _ = server._route("POST", "/register", {"x-internal-secret": ""}, _register_body())
        assert status == "401 Unauthorized"
    finally:
        importlib.reload(main_module)


def test_register_accepted_with_correct_secret(monkeypatch):
    mod = _reload_main(monkeypatch, secret="s3cret")
    try:
        server = mod.PreRegistrationServer({})
        status, body = server._route(
            "POST", "/register", {"x-internal-secret": "s3cret"}, _register_body()
        )
        assert status == "200 OK"
        assert json.loads(body) == {"status": "registered"}
        assert "abc-123" in server._registry
        pending = server._registry["abc-123"]
        assert pending.extension == "2001"
        assert pending.tenant_id == "tenant-1"
    finally:
        importlib.reload(main_module)
