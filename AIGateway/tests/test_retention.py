"""Self-contained tests for gateway log retention: partial settings update,
opt-in automatic purge and the internal retention endpoints.

No live services: database access is replaced with fakes.
"""

import os
import sys
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import crud.guardrails as guardrails_crud
import routers.retention as retention_router


def _fake_db(rows=None):
    """A get_db replacement that records every executed statement."""
    executed = []

    result = MagicMock()
    result.mappings.return_value.first.return_value = {}
    result.mappings.return_value.all.return_value = rows or []

    db = MagicMock()

    async def execute(stmt, params=None):
        executed.append((stmt, params))
        return result

    db.execute = execute
    db.commit = AsyncMock()

    @asynccontextmanager
    async def get_db():
        yield db

    return get_db, executed


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect()))


# ---------------------------------------------------------------------------
# Partial settings update
# ---------------------------------------------------------------------------


async def test_partial_update_only_sets_present_keys(monkeypatch):
    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    await guardrails_crud.upsert_guardrail_settings(
        7, {"spend_log_retention_days": 30}
    )

    stmt, params = executed[0]
    sql = _sql(stmt)
    conflict = sql.split("ON CONFLICT")[1]
    assert "spend_log_retention_days" in conflict
    # Keys absent from the body are not touched on update.
    assert "pii_on_error" not in conflict
    assert "log_retention_days" not in conflict.replace("spend_log_retention_days", "")
    assert "auto_purge_enabled" not in conflict
    assert params["spend_log_retention_days"] == 30
    # The INSERT still fills the missing keys with defaults.
    assert params["pii_on_error"] == "block"
    assert params["log_retention_days"] == 90
    assert params["auto_purge_enabled"] is False


async def test_full_update_sets_every_whitelisted_key(monkeypatch):
    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    await guardrails_crud.upsert_guardrail_settings(
        7,
        {
            "pii_on_error": "allow",
            "log_retention_days": 14,
            "auto_purge_enabled": True,
            "unknown_column": "x; DROP TABLE y",
        },
    )

    stmt, params = executed[0]
    sql = _sql(stmt)
    conflict = sql.split("ON CONFLICT")[1]
    assert "pii_on_error" in conflict
    assert "auto_purge_enabled" in conflict
    assert "unknown_column" not in sql
    assert "unknown_column" not in params


@pytest.mark.parametrize(
    "body",
    [
        {"log_retention_days": 0},
        {"spend_log_retention_days": -5},
        {"spend_log_retention_days": "30"},
        {"log_retention_days": True},
        {"log_retention_days": 1.5},
        {"auto_purge_enabled": "yes"},
        {"auto_purge_enabled": 1},
    ],
)
async def test_invalid_values_are_rejected(monkeypatch, body):
    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    with pytest.raises(HTTPException) as exc:
        await guardrails_crud.upsert_guardrail_settings(7, body)
    assert exc.value.status_code == 400
    assert executed == []


# ---------------------------------------------------------------------------
# Internal retention endpoints
# ---------------------------------------------------------------------------


def _request():
    return SimpleNamespace(headers={}, state=SimpleNamespace())


async def test_config_returns_audit_retention_days_at_top_level(monkeypatch):
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)
    monkeypatch.setattr(retention_router.settings, "mcp_audit_retention_days", 45)

    assert await retention_router.get_retention_config(_request()) == {
        "mcp_audit_retention_days": 45
    }


async def test_purge_only_selects_opted_in_orgs(monkeypatch):
    get_db, executed = _fake_db(rows=[])
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)

    out = await retention_router.purge_retention(_request())

    assert out == {"results": []}
    assert "auto_purge_enabled" in _sql(executed[0][0]) or "auto_purge_enabled" in str(
        executed[0][0]
    )


async def test_purge_uses_each_orgs_periods(monkeypatch):
    rows = [
        {"organization_id": 1, "log_retention_days": 14, "spend_log_retention_days": 60},
        {"organization_id": 2, "log_retention_days": 90, "spend_log_retention_days": 7},
    ]
    get_db, _ = _fake_db(rows=rows)
    guardrail_purge = AsyncMock(side_effect=[3, 5])
    spend_purge = AsyncMock(side_effect=[{"deleted": 11}, {"deleted": 13}])
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)
    monkeypatch.setattr(retention_router, "purge_guardrail_logs", guardrail_purge)
    monkeypatch.setattr(retention_router.spend_crud, "purge_spend_logs", spend_purge)

    out = await retention_router.purge_retention(_request())

    assert out["results"] == [
        {"organization_id": 1, "guardrail_deleted": 3, "spend_deleted": 11},
        {"organization_id": 2, "guardrail_deleted": 5, "spend_deleted": 13},
    ]
    guardrail_purge.assert_any_await(1, 14)
    guardrail_purge.assert_any_await(2, 90)
    assert spend_purge.await_args_list[0].args[1:] == (1, 60)
    assert spend_purge.await_args_list[1].args[1:] == (2, 7)


async def test_one_failing_org_does_not_stop_the_others(monkeypatch):
    rows = [
        {"organization_id": 1, "log_retention_days": 14, "spend_log_retention_days": 60},
        {"organization_id": 2, "log_retention_days": 14, "spend_log_retention_days": 60},
    ]
    get_db, _ = _fake_db(rows=rows)

    async def guardrail_purge(org_id, days):
        if org_id == 1:
            raise RuntimeError("boom")
        return 4

    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)
    monkeypatch.setattr(retention_router, "purge_guardrail_logs", guardrail_purge)
    monkeypatch.setattr(
        retention_router.spend_crud,
        "purge_spend_logs",
        AsyncMock(return_value={"deleted": 2}),
    )

    out = await retention_router.purge_retention(_request())

    first, second = out["results"]
    assert first["organization_id"] == 1
    assert first["error"] == "boom"
    assert second == {"organization_id": 2, "guardrail_deleted": 4, "spend_deleted": 2}
