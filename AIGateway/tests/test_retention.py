"""Self-contained tests for gateway log retention: partial settings update,
opt-in automatic purge and the internal retention endpoints.

No live services: database access is replaced with fakes.
"""

import os
import sys
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import crud.guardrails as guardrails_crud
import crud.spend as spend_crud
import routers.retention as retention_router
from crud.purge import MAX_RETENTION_DAYS, PartialPurgeError, retention_cutoff


def _fake_db(rows=None):
    """A get_db replacement that records every executed statement."""
    executed = []

    result = MagicMock()
    result.mappings.return_value.first.return_value = rows[0] if rows else None
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
        {"log_retention_days": MAX_RETENTION_DAYS + 1},
        {"spend_log_retention_days": 10**9},
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


async def test_ten_years_is_the_longest_accepted_period(monkeypatch):
    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    await guardrails_crud.upsert_guardrail_settings(
        7, {"log_retention_days": 3650, "spend_log_retention_days": 3650}
    )

    assert executed[0][1]["log_retention_days"] == 3650
    assert executed[0][1]["spend_log_retention_days"] == 3650


async def test_out_of_range_error_names_the_range(monkeypatch):
    get_db, _ = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    with pytest.raises(HTTPException) as exc:
        await guardrails_crud.upsert_guardrail_settings(7, {"log_retention_days": 3651})
    assert exc.value.detail == "log_retention_days must be an integer from 1 to 3650"


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

    out = await retention_router.purge_retention(
        _request(), retention_router.PurgeRequest(organization_id=1)
    )

    assert out == {"results": []}
    assert "auto_purge_enabled" in str(executed[0][0])


async def test_guardrail_failure_does_not_stop_the_spend_purge(monkeypatch):
    rows = [{"organization_id": 1, "log_retention_days": 14, "spend_log_retention_days": 60}]
    get_db, _ = _fake_db(rows=rows)
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)
    monkeypatch.setattr(
        retention_router, "purge_guardrail_logs", AsyncMock(side_effect=RuntimeError("boom"))
    )
    spend_purge = AsyncMock(return_value={"deleted": 2, "capped": False})
    monkeypatch.setattr(retention_router.spend_crud, "purge_spend_logs", spend_purge)

    (entry,) = (
        await retention_router.purge_retention(
            _request(), retention_router.PurgeRequest(organization_id=1)
        )
    )["results"]

    assert entry["guardrail_error"] == "boom"
    assert entry["guardrail_deleted"] == 0
    assert "spend_error" not in entry
    assert entry["spend_deleted"] == 2
    assert spend_purge.await_args_list[0].args[1:] == (1, 60)


async def test_spend_failure_does_not_mark_guardrail_failed(monkeypatch):
    rows = [{"organization_id": 1, "log_retention_days": 14, "spend_log_retention_days": 60}]
    get_db, _ = _fake_db(rows=rows)
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)
    monkeypatch.setattr(
        retention_router,
        "purge_guardrail_logs",
        AsyncMock(return_value={"deleted": 7, "capped": False}),
    )
    monkeypatch.setattr(
        retention_router.spend_crud,
        "purge_spend_logs",
        AsyncMock(side_effect=RuntimeError("spend down")),
    )

    (entry,) = (
        await retention_router.purge_retention(
            _request(), retention_router.PurgeRequest(organization_id=1)
        )
    )["results"]

    assert entry["guardrail_deleted"] == 7
    assert "guardrail_error" not in entry
    assert entry["spend_error"] == "spend down"


# ---------------------------------------------------------------------------
# Batch cap
# ---------------------------------------------------------------------------


def _counting_db(rowcounts):
    """A fake session whose DELETEs report the given rowcounts in turn."""
    calls = []
    db = MagicMock()

    async def execute(stmt, params=None):
        calls.append(params)
        result = MagicMock()
        result.rowcount = rowcounts[len(calls) - 1]
        return result

    db.execute = execute
    db.commit = AsyncMock()
    return db, calls


async def test_guardrail_purge_reports_capped_when_last_batch_is_full(monkeypatch):
    db, calls = _counting_db([1000, 1000, 1000])

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    out = await guardrails_crud.purge_guardrail_logs(7, 30, max_batches=3)
    assert out == {"deleted": 3000, "capped": True}
    assert len(calls) == 3


async def test_guardrail_purge_not_capped_when_rows_run_out(monkeypatch):
    db, calls = _counting_db([1000, 400])

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    out = await guardrails_crud.purge_guardrail_logs(7, 30, max_batches=3)
    assert out == {"deleted": 1400, "capped": False}
    assert len(calls) == 2


async def test_guardrail_purge_default_keeps_manual_cap_of_50(monkeypatch):
    db, calls = _counting_db([1000] * 60)

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    out = await guardrails_crud.purge_guardrail_logs(7, 30)
    assert out == {"deleted": 50000, "capped": True}
    assert len(calls) == 50


async def test_spend_purge_reports_capped(monkeypatch):
    db, calls = _counting_db([1000, 1000])
    out = await spend_crud.purge_spend_logs(db, 7, 30, max_batches=2)
    assert out == {"deleted": 2000, "batches": 2, "capped": True}

    db, calls = _counting_db([1000, 10])
    out = await spend_crud.purge_spend_logs(db, 7, 30, max_batches=5)
    assert out == {"deleted": 1010, "batches": 2, "capped": False}

    db, calls = _counting_db([1000] * 60)
    out = await spend_crud.purge_spend_logs(db, 7, 30)
    assert out["batches"] == 50 and out["capped"] is True


async def test_spend_purge_commits_each_batch():
    db, calls = _counting_db([1000, 1000, 10])
    out = await spend_crud.purge_spend_logs(db, 7, 30, max_batches=5)
    assert out["batches"] == 3
    # One commit per batch, so deleted batches survive a later failure.
    assert db.commit.await_count == 3


# ---------------------------------------------------------------------------
# Per-organization purge
# ---------------------------------------------------------------------------


async def test_purge_for_one_org_scopes_the_query_and_caps_at_100(monkeypatch):
    rows = [{"organization_id": 4, "log_retention_days": 30, "spend_log_retention_days": 15}]
    get_db, executed = _fake_db(rows=rows)
    guardrail_purge = AsyncMock(return_value={"deleted": 100000, "capped": True})
    spend_purge = AsyncMock(return_value={"deleted": 9, "capped": False})
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)
    monkeypatch.setattr(retention_router, "purge_guardrail_logs", guardrail_purge)
    monkeypatch.setattr(retention_router.spend_crud, "purge_spend_logs", spend_purge)

    out = await retention_router.purge_retention(
        _request(), retention_router.PurgeRequest(organization_id=4)
    )

    select_sql, select_params = executed[0]
    assert "auto_purge_enabled" in str(select_sql)
    assert "organization_id = :org_id" in str(select_sql)
    assert select_params == {"org_id": 4}
    assert out["results"] == [
        {
            "organization_id": 4,
            "guardrail_deleted": 100000,
            "guardrail_capped": True,
            "spend_deleted": 9,
            "spend_capped": False,
        }
    ]
    guardrail_purge.assert_awaited_once_with(4, 30, max_batches=100)
    assert spend_purge.await_args_list[0].kwargs == {"max_batches": 100}


async def test_purge_for_an_org_that_did_not_opt_in_returns_nothing(monkeypatch):
    get_db, executed = _fake_db(rows=[])
    guardrail_purge = AsyncMock()
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)
    monkeypatch.setattr(retention_router, "purge_guardrail_logs", guardrail_purge)

    out = await retention_router.purge_retention(
        _request(), retention_router.PurgeRequest(organization_id=9)
    )

    assert out == {"results": []}
    guardrail_purge.assert_not_awaited()


def test_purge_request_requires_an_integer_org_id():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        retention_router.PurgeRequest(organization_id="4")
    with pytest.raises(ValidationError):
        retention_router.PurgeRequest()


def test_purge_route_requires_a_body():
    import inspect

    payload = inspect.signature(retention_router.purge_retention).parameters["payload"]
    assert payload.default is inspect.Parameter.empty
    assert not hasattr(retention_router, "AUTO_PURGE_MAX_BATCHES")


# ---------------------------------------------------------------------------
# Partial purges and long periods
# ---------------------------------------------------------------------------


def _failing_db(rowcounts):
    """A fake session whose DELETEs report the given rowcounts, then fail."""
    calls = []
    db = MagicMock()

    async def execute(stmt, params=None):
        calls.append(params)
        if len(calls) > len(rowcounts):
            raise RuntimeError("connection lost")
        result = MagicMock()
        result.rowcount = rowcounts[len(calls) - 1]
        return result

    db.execute = execute
    db.commit = AsyncMock()
    return db, calls


async def test_spend_purge_failure_carries_the_rows_already_deleted():
    db, _ = _failing_db([1000, 1000])

    with pytest.raises(PartialPurgeError) as exc:
        await spend_crud.purge_spend_logs(db, 7, 30, max_batches=5)

    assert exc.value.deleted == 2000
    assert str(exc.value) == "connection lost"
    assert isinstance(exc.value.__cause__, RuntimeError)


async def test_guardrail_purge_failure_carries_the_rows_already_deleted(monkeypatch):
    db, _ = _failing_db([1000])

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    with pytest.raises(PartialPurgeError) as exc:
        await guardrails_crud.purge_guardrail_logs(7, 30, max_batches=5)
    assert exc.value.deleted == 1000


async def test_purge_reports_partial_counts_and_marks_the_type_failed(monkeypatch):
    rows = [{"organization_id": 3, "log_retention_days": 14, "spend_log_retention_days": 60}]
    get_db, _ = _fake_db(rows=rows)
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "verify_internal_key", lambda r: None)
    monkeypatch.setattr(
        retention_router,
        "purge_guardrail_logs",
        AsyncMock(side_effect=PartialPurgeError(4000, RuntimeError("timeout"))),
    )
    monkeypatch.setattr(
        retention_router.spend_crud,
        "purge_spend_logs",
        AsyncMock(side_effect=PartialPurgeError(1500, RuntimeError("disk full"))),
    )

    (entry,) = (
        await retention_router.purge_retention(
            _request(), retention_router.PurgeRequest(organization_id=3)
        )
    )["results"]

    assert entry["guardrail_deleted"] == 4000
    assert entry["guardrail_error"] == "timeout"
    assert entry["spend_deleted"] == 1500
    assert entry["spend_error"] == "disk full"


async def test_purges_with_the_longest_period_do_not_overflow(monkeypatch):
    db, calls = _counting_db([0])
    out = await spend_crud.purge_spend_logs(db, 7, MAX_RETENTION_DAYS)
    assert out == {"deleted": 0, "batches": 1, "capped": False}

    gdb, gcalls = _counting_db([0])

    @asynccontextmanager
    async def get_db():
        yield gdb

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)
    out = await guardrails_crud.purge_guardrail_logs(7, MAX_RETENTION_DAYS)
    assert out == {"deleted": 0, "capped": False}
    expected = datetime.now(tz=timezone.utc) - timedelta(days=MAX_RETENTION_DAYS)
    assert abs(gcalls[0]["cutoff"] - expected) < timedelta(minutes=1)


async def test_guardrail_purge_binds_the_python_cutoff(monkeypatch):
    db, calls = _counting_db([0])

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)
    before = datetime.now(tz=timezone.utc)
    await guardrails_crud.purge_guardrail_logs(7, 30)

    assert set(calls[0]) == {"org_id", "cutoff", "batch_size"}
    assert isinstance(calls[0]["cutoff"], datetime)
    assert abs(calls[0]["cutoff"] - (before - timedelta(days=30))) < timedelta(minutes=1)


async def test_a_period_saved_before_the_cap_deletes_nothing_instead_of_failing(monkeypatch):
    assert retention_cutoff(10**9) is None

    db, calls = _counting_db([])
    out = await spend_crud.purge_spend_logs(db, 7, 10**9)
    assert out == {"deleted": 0, "batches": 0, "capped": False}
    assert calls == []

    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)
    out = await guardrails_crud.purge_guardrail_logs(7, 10**9)
    assert out == {"deleted": 0, "capped": False}
    assert executed == []
