"""Self-contained tests for the internal key checks and the observability
config fetch: no live services."""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

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


def test_verify_internal_key_still_passes_when_no_key_is_configured(monkeypatch):
    """Fail-open when unset is unchanged here (a separate decision)."""
    monkeypatch.setattr(settings, "ai_gateway_internal_key", "")
    assert auth.verify_internal_key(_request("anything")) is None


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
