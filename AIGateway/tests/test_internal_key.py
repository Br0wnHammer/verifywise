"""Self-contained tests for the internal key checks and the observability
config fetch: no live services."""

import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import httpx
import observability
from config import settings
from middlewares import auth


def _request(key=None):
    headers = {} if key is None else {"x-internal-key": key}
    return SimpleNamespace(
        headers=headers, method="GET", url=SimpleNamespace(path="/internal/x")
    )


@pytest.mark.parametrize(
    "provided, expected, match",
    [("k", "k", True), ("k", "j", False), ("clé-ü", "k", False), ("", "k", False)],
)
def test_keys_match_compares_bytes(provided, expected, match):
    assert auth.keys_match(provided, expected) is match


def test_verify_internal_key_rejects_a_non_ascii_header_with_401(monkeypatch):
    """Comparing two str with non-ASCII characters raised TypeError (500)."""
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "right-key")
    with pytest.raises(HTTPException) as exc:
        auth.verify_internal_key(_request("clé-ü"))
    assert exc.value.status_code == 401


def test_verify_internal_key_accepts_the_right_key(monkeypatch):
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "right-key")
    assert auth.verify_internal_key(_request("right-key")) is None


@pytest.mark.parametrize("configured", ["", "   "])
def test_verify_internal_key_refuses_every_request_when_no_key_is_configured(
    monkeypatch, configured
):
    """Fail closed: without a configured key nothing is served (503 + code)."""
    import config

    monkeypatch.setenv("AI_GATEWAY_INTERNAL_KEY", configured)
    monkeypatch.setattr(settings, "ai_gateway_internal_key", config.Settings().ai_gateway_internal_key)
    with pytest.raises(HTTPException) as exc:
        auth.verify_internal_key(_request("anything"))
    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == "internal_key_not_configured"


@pytest.mark.parametrize("key", [None, "", "wrong-key", "clé-ü"])
def test_verify_internal_key_rejects_a_missing_or_wrong_key_with_a_code(monkeypatch, key):
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "right-key")
    with pytest.raises(HTTPException) as exc:
        auth.verify_internal_key(_request(key))
    assert exc.value.status_code == 401
    assert exc.value.detail["code"] == "internal_key_rejected"


def test_there_is_one_internal_key_check():
    assert not hasattr(auth, "require_internal_key")


# ---------------------------------------------------------------------------
# A non-retention internal route, end to end over HTTP
# ---------------------------------------------------------------------------


def _cache_client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import routers.cache as cache_router

    stats = AsyncMock(return_value={"entries": 3})
    monkeypatch.setattr(cache_router, "get_cache_stats", stats)

    app = FastAPI()

    @app.middleware("http")
    async def tenant(request, call_next):  # stands in for TenantMiddleware
        request.state.organization_id = 7
        return await call_next(request)

    app.include_router(cache_router.router, prefix="/internal")
    return TestClient(app), stats


def test_internal_route_answers_503_with_code_when_no_key_is_configured(monkeypatch):
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "")
    client, stats = _cache_client(monkeypatch)

    response = client.get("/internal/cache/stats", headers={"x-internal-key": "anything"})

    assert response.status_code == 503
    assert response.json() == {
        "detail": {"message": "Internal key not configured", "code": "internal_key_not_configured"}
    }
    stats.assert_not_awaited()


@pytest.mark.parametrize("headers", [{}, {"x-internal-key": "wrong-key"}])
def test_internal_route_answers_401_with_code_for_a_missing_or_wrong_key(monkeypatch, headers):
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "right-key")
    client, stats = _cache_client(monkeypatch)

    response = client.get("/internal/cache/stats", headers=headers)

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "internal_key_rejected"
    stats.assert_not_awaited()


def test_internal_route_rejects_a_non_ascii_key_with_401_not_500(monkeypatch):
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "right-key")
    client, _ = _cache_client(monkeypatch)

    # HTTP headers travel as latin-1; this is a non-ASCII key on the wire.
    response = client.get(
        "/internal/cache/stats", headers={"x-internal-key": "clé".encode("latin-1")}
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "internal_key_rejected"


def test_internal_route_serves_the_right_key(monkeypatch):
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "right-key")
    client, stats = _cache_client(monkeypatch)

    response = client.get("/internal/cache/stats", headers={"x-internal-key": "right-key"})

    assert response.status_code == 200
    stats.assert_awaited_once_with(7)


def test_observability_config_fetch_sends_the_trimmed_settings_key(monkeypatch):
    monkeypatch.setenv("BACKEND_URL", "http://backend:3000")
    monkeypatch.setenv("AI_GATEWAY_INTERNAL_KEY", "  raw-key\n")
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "raw-key")
    response = MagicMock()
    response.json.return_value = {"enabled": False}
    get = MagicMock(return_value=response)
    monkeypatch.setattr(httpx, "get", get)

    observability._fetch_config()

    assert get.call_args.kwargs["headers"] == {"x-internal-key": "raw-key"}


def test_observability_config_fetch_skips_the_call_without_a_key(monkeypatch):
    monkeypatch.setenv("BACKEND_URL", "http://backend:3000")
    monkeypatch.setenv("AI_GATEWAY_INTERNAL_KEY", "   ")
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "")
    get = MagicMock()
    monkeypatch.setattr(httpx, "get", get)

    observability._fetch_config()

    get.assert_not_called()


def test_observability_config_falls_back_to_env_when_settings_fail(monkeypatch):
    """A settings error must not block startup: the env config is used."""
    import types

    monkeypatch.setenv("BACKEND_URL", "http://backend:3000")
    monkeypatch.setenv("OTEL_ENABLED", "true")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel:4318")
    # A config module whose settings cannot be imported.
    monkeypatch.setitem(sys.modules, "config", types.ModuleType("config"))
    get = MagicMock()
    monkeypatch.setattr(httpx, "get", get)

    result = observability._fetch_config()

    get.assert_not_called()
    assert result["enabled"] is True
    assert result["otlp_endpoint"] == "http://otel:4318"
