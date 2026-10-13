"""Creating an MCP server triggers background tool discovery (issue #4908).

Self-contained: no live services. The CRUD layer and the discovery service
are mocked; discovery runs in a background task, so the tests let the loop
settle before asserting. A discovery failure must never fail the creation —
it only marks the server unhealthy and logs.
"""

import asyncio
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest

import routers.mcp_servers as mcp_servers


def _request(body: dict) -> SimpleNamespace:
    async def _json() -> dict:
        return body

    return SimpleNamespace(json=_json)


def _server() -> dict:
    return {
        "id": 7,
        "slug": "search",
        "url": "http://localhost:9",
        "auth_type": "none",
        "auth_config": None,
    }


def _install_mocks(monkeypatch):
    """Patch the create route's collaborators; returns (crud, notify)."""
    crud = MagicMock()
    crud.create_mcp_server = AsyncMock(return_value=_server())
    crud.update_server_health = AsyncMock()
    notify = AsyncMock()
    monkeypatch.setattr(mcp_servers, "mcp_servers_crud", crud)
    monkeypatch.setattr(mcp_servers, "notify_config_change", notify)
    monkeypatch.setattr(mcp_servers, "require_admin", lambda request: None)
    monkeypatch.setattr(mcp_servers, "get_org_id", lambda request: 1)
    monkeypatch.setattr(mcp_servers, "get_user_id", lambda request: 2)
    return crud, notify


def _patch_discovery_service(monkeypatch, **kwargs):
    """Point the helper's deferred import at a mocked discovery service."""
    fake_module = SimpleNamespace(discover_server_tools=AsyncMock(**kwargs))
    monkeypatch.setitem(sys.modules, "services.mcp_proxy_service", fake_module)
    return fake_module.discover_server_tools


def _create_payload() -> dict:
    return {"name": "Search", "slug": "search", "url": "http://localhost:9"}


async def test_create_triggers_background_discovery(monkeypatch):
    crud, _ = _install_mocks(monkeypatch)
    discover = _patch_discovery_service(monkeypatch, return_value=[{"name": "search_docs"}])

    result = await mcp_servers.create_mcp_server(_request(_create_payload()))

    assert result["server"]["id"] == 7
    # Let the fire-and-forget background task run.
    await asyncio.sleep(0.05)
    assert discover.await_count == 1
    crud.update_server_health.assert_awaited_with(7, "healthy")


async def test_discovery_failure_still_creates_and_marks_unhealthy(monkeypatch):
    crud, _ = _install_mocks(monkeypatch)
    discover = _patch_discovery_service(
        monkeypatch, side_effect=RuntimeError("server unreachable")
    )

    result = await mcp_servers.create_mcp_server(_request(_create_payload()))

    assert result["server"]["id"] == 7
    await asyncio.sleep(0.05)
    assert discover.await_count == 1
    crud.update_server_health.assert_awaited_with(7, "unhealthy")


async def test_helper_marks_unhealthy_and_reraises_on_failure(monkeypatch):
    crud, _ = _install_mocks(monkeypatch)
    _patch_discovery_service(monkeypatch, side_effect=RuntimeError("boom"))

    with pytest.raises(RuntimeError):
        await mcp_servers._discover_server_tools(1, _server())
    crud.update_server_health.assert_awaited_with(7, "unhealthy")
