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


def _upserts(executed):
    """The settings upserts among the executed statements (each save first
    creates a missing row and reads the previous values with a locked SELECT)."""
    return [entry for entry in executed if "DO UPDATE" in str(entry[0])]


# ---------------------------------------------------------------------------
# Partial settings update
# ---------------------------------------------------------------------------


async def test_partial_update_only_sets_present_keys(monkeypatch):
    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    await guardrails_crud.upsert_guardrail_settings_with_previous(
        7, {"spend_log_retention_days": 30}
    )

    stmt, params = _upserts(executed)[0]
    # Only keys present in the body are flagged for update; the rest keep the
    # stored value on conflict.
    assert params["set_spend_log_retention_days"] is True
    assert params["set_pii_on_error"] is False
    assert params["set_log_retention_days"] is False
    assert params["set_auto_purge_enabled"] is False
    assert params["spend_log_retention_days"] == 30
    # The INSERT still fills the missing keys with defaults.
    assert params["pii_on_error"] == "block"
    assert params["log_retention_days"] == 90
    assert params["auto_purge_enabled"] is False


async def test_full_update_sets_every_whitelisted_key(monkeypatch):
    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    await guardrails_crud.upsert_guardrail_settings_with_previous(
        7,
        {
            "pii_on_error": "allow",
            "log_retention_days": 14,
            "auto_purge_enabled": True,
            "unknown_column": "x; DROP TABLE y",
        },
    )

    stmt, params = _upserts(executed)[0]
    sql = _sql(stmt)
    assert params["set_pii_on_error"] is True
    assert params["set_log_retention_days"] is True
    assert params["set_auto_purge_enabled"] is True
    assert params["set_spend_log_retention_days"] is False
    assert "unknown_column" not in sql
    assert "unknown_column" not in params
    assert "set_unknown_column" not in params


async def test_upsert_statement_is_static(monkeypatch):
    """The SQL text must not depend on which keys the caller sent."""
    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    await guardrails_crud.upsert_guardrail_settings_with_previous(7, {"log_retention_days": 30})
    await guardrails_crud.upsert_guardrail_settings_with_previous(
        7, {"pii_on_error": "allow", "auto_purge_enabled": True}
    )

    assert _sql(_upserts(executed)[0][0]) == _sql(_upserts(executed)[1][0])
    conflict = _sql(_upserts(executed)[0][0]).split("ON CONFLICT")[1]
    assert "ELSE s.pii_on_error" in conflict


def _sequenced_db(*firsts):
    """A get_db replacement whose statements return the given rows in turn."""
    executed = []
    db = MagicMock()

    async def execute(stmt, params=None):
        executed.append((stmt, params))
        result = MagicMock()
        result.mappings.return_value.first.return_value = firsts[len(executed) - 1]
        return result

    db.execute = execute
    db.commit = AsyncMock()

    @asynccontextmanager
    async def get_db():
        yield db

    return get_db, executed, db


async def test_save_returns_the_retention_values_it_replaced(monkeypatch):
    stored = {"log_retention_days": 60, "spend_log_retention_days": 90, "auto_purge_enabled": False}
    saved = {"organization_id": 7, "log_retention_days": 30, "auto_purge_enabled": True}
    # Statements in turn: create-if-missing, locked read, upsert.
    get_db, executed, db = _sequenced_db(None, stored, saved)
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    settings, previous = await guardrails_crud.upsert_guardrail_settings_with_previous(
        7, {"log_retention_days": 30, "auto_purge_enabled": True}
    )

    assert previous == stored
    assert settings == saved
    create_sql, create_params = executed[0]
    lock_sql, lock_params = executed[1]
    assert "ON CONFLICT (organization_id) DO NOTHING" in str(create_sql)
    assert "FOR UPDATE" in str(lock_sql)
    assert lock_params == {"org_id": 7}
    assert "DO UPDATE" in str(executed[2][0])
    db.commit.assert_awaited_once()


async def test_first_save_creates_the_row_with_defaults_before_locking(monkeypatch):
    """Sequential simulation of a first save: the row is created with the
    defaults (ON CONFLICT DO NOTHING), so the locked read finds a row and a
    concurrent first save waits on its lock instead of also seeing nothing.
    The real concurrent behaviour needs Postgres; see the PR notes."""
    defaults = {"log_retention_days": 90, "spend_log_retention_days": 90, "auto_purge_enabled": False}
    saved = {"organization_id": 7, "log_retention_days": 30}
    get_db, executed, _ = _sequenced_db(None, defaults, saved)
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    settings, previous = await guardrails_crud.upsert_guardrail_settings_with_previous(
        7, {"log_retention_days": 30}
    )

    create_sql, create_params = executed[0]
    assert str(create_sql).index("INSERT INTO") < str(create_sql).index("DO NOTHING")
    # The created row takes the defaults, never the submitted values.
    assert create_params["default_log_retention_days"] == 90
    assert create_params["default_auto_purge_enabled"] is False
    assert create_params["org_id"] == 7
    # The previous values are the defaults the organization was running with.
    assert previous == defaults
    assert settings == saved


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
        await guardrails_crud.upsert_guardrail_settings_with_previous(7, body)
    assert exc.value.status_code == 400
    assert executed == []


async def test_ten_years_is_the_longest_accepted_period(monkeypatch):
    get_db, executed = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    await guardrails_crud.upsert_guardrail_settings_with_previous(
        7, {"log_retention_days": 3650, "spend_log_retention_days": 3650}
    )

    assert _upserts(executed)[0][1]["log_retention_days"] == 3650
    assert _upserts(executed)[0][1]["spend_log_retention_days"] == 3650


async def test_out_of_range_error_names_the_range(monkeypatch):
    get_db, _ = _fake_db()
    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    with pytest.raises(HTTPException) as exc:
        await guardrails_crud.upsert_guardrail_settings_with_previous(7, {"log_retention_days": 3651})
    assert exc.value.detail == "log_retention_days must be an integer from 1 to 3650"


# ---------------------------------------------------------------------------
# Internal retention endpoints
# ---------------------------------------------------------------------------


def _request():
    return SimpleNamespace(headers={}, state=SimpleNamespace())


# ---------------------------------------------------------------------------
# Internal key: the retention routes fail closed
# ---------------------------------------------------------------------------


def _keyed_request(key=None):
    headers = {} if key is None else {"x-internal-key": key}
    return SimpleNamespace(
        headers=headers,
        state=SimpleNamespace(),
        method="POST",
        url=SimpleNamespace(path="/internal/retention/purge"),
    )


def _no_db(monkeypatch):
    """Fail the test if a refused request reaches the database."""

    @asynccontextmanager
    async def get_db():
        raise AssertionError("refused request must not touch the database")
        yield  # pragma: no cover

    monkeypatch.setattr(retention_router, "get_db", get_db)


async def test_retention_routes_refuse_when_no_internal_key_is_configured(monkeypatch):
    monkeypatch.setattr(retention_router.settings, "ai_gateway_internal_key", "")
    _no_db(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        await retention_router.get_retention_config(_keyed_request("anything"))
    assert exc.value.status_code == 503
    # A machine code lets the backend tell this from a proxy's 503.
    assert exc.value.detail["code"] == "internal_key_not_configured"

    with pytest.raises(HTTPException) as exc:
        await retention_router.purge_retention(
            _keyed_request(), retention_router.PurgeRequest(organization_id=1)
        )
    assert exc.value.status_code == 503


@pytest.mark.parametrize("key", [None, "", "wrong-key"])
async def test_retention_routes_reject_a_wrong_internal_key(monkeypatch, key):
    monkeypatch.setattr(retention_router.settings, "ai_gateway_internal_key", "right-key")
    _no_db(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        await retention_router.purge_retention(
            _keyed_request(key), retention_router.PurgeRequest(organization_id=1)
        )
    assert exc.value.status_code == 401

    with pytest.raises(HTTPException) as exc:
        await retention_router.get_retention_config(_keyed_request(key))
    assert exc.value.status_code == 401
    assert exc.value.detail["code"] == "internal_key_rejected"


async def test_retention_routes_serve_the_right_internal_key(monkeypatch):
    monkeypatch.setattr(retention_router.settings, "ai_gateway_internal_key", "right-key")
    monkeypatch.setattr(retention_router.settings, "mcp_audit_retention_days", 30)
    assert await retention_router.get_retention_config(_keyed_request("right-key")) == {
        "mcp_audit_retention_days": 30
    }

    # The purge gets past the key check and looks up the organization.
    get_db, executed = _fake_db()
    monkeypatch.setattr(retention_router, "get_db", get_db)
    await retention_router.purge_retention(
        _keyed_request("right-key"), retention_router.PurgeRequest(organization_id=1)
    )
    assert "auto_purge_enabled" in str(executed[0][0])


async def test_config_returns_audit_retention_days_at_top_level(monkeypatch):
    monkeypatch.setattr(retention_router, "require_internal_key", lambda r: None)
    monkeypatch.setattr(retention_router.settings, "mcp_audit_retention_days", 45)

    assert await retention_router.get_retention_config(_request()) == {
        "mcp_audit_retention_days": 45
    }


async def test_purge_only_selects_opted_in_orgs(monkeypatch):
    get_db, executed = _fake_db(rows=[])
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "require_internal_key", lambda r: None)

    out = await retention_router.purge_retention(
        _request(), retention_router.PurgeRequest(organization_id=1)
    )

    assert out == {"results": []}
    assert "auto_purge_enabled" in str(executed[0][0])


async def test_guardrail_failure_does_not_stop_the_spend_purge(monkeypatch):
    rows = [{"organization_id": 1, "log_retention_days": 14, "spend_log_retention_days": 60}]
    get_db, _ = _fake_db(rows=rows)
    monkeypatch.setattr(retention_router, "get_db", get_db)
    monkeypatch.setattr(retention_router, "require_internal_key", lambda r: None)
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
    monkeypatch.setattr(retention_router, "require_internal_key", lambda r: None)
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


def _counting_db(rowcounts, remaining=True):
    """A fake session whose DELETEs report the given rowcounts in turn. The
    "are older rows left" check answers `remaining`; it is not recorded in
    `calls`, which holds the DELETEs only."""
    calls = []
    db = MagicMock()
    db.exists_checks = 0

    async def execute(stmt, params=None):
        result = MagicMock()
        if "SELECT EXISTS" in str(stmt):
            db.exists_checks += 1
            if isinstance(remaining, Exception):
                raise remaining
            result.scalar.return_value = remaining
            return result
        calls.append(params)
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


async def test_guardrail_purge_not_capped_when_the_last_full_batch_emptied_it(monkeypatch):
    db, calls = _counting_db([1000, 1000, 1000], remaining=False)

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    out = await guardrails_crud.purge_guardrail_logs(7, 30, max_batches=3)
    assert out == {"deleted": 3000, "capped": False}
    assert db.exists_checks == 1


async def test_guardrail_purge_not_capped_when_rows_run_out(monkeypatch):
    db, calls = _counting_db([1000, 400])

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    out = await guardrails_crud.purge_guardrail_logs(7, 30, max_batches=3)
    assert out == {"deleted": 1400, "capped": False}
    assert len(calls) == 2
    # A short batch already proves nothing is left: no extra check.
    assert db.exists_checks == 0


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


async def test_spend_purge_not_capped_when_the_last_full_batch_emptied_it():
    db, calls = _counting_db([1000, 1000], remaining=False)
    out = await spend_crud.purge_spend_logs(db, 7, 30, max_batches=2)
    assert out == {"deleted": 2000, "batches": 2, "capped": False}
    assert db.exists_checks == 1


async def test_guardrail_purge_failing_remaining_check_reports_capped(monkeypatch):
    db, calls = _counting_db([1000, 1000], remaining=RuntimeError("read timeout"))

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(guardrails_crud, "get_db", get_db)

    # The deletes succeeded: no PartialPurgeError, and capped stays True so
    # the caller runs the purge again.
    out = await guardrails_crud.purge_guardrail_logs(7, 30, max_batches=2)
    assert out == {"deleted": 2000, "capped": True}


async def test_spend_purge_failing_remaining_check_reports_capped():
    db, calls = _counting_db([1000, 1000], remaining=RuntimeError("read timeout"))
    out = await spend_crud.purge_spend_logs(db, 7, 30, max_batches=2)
    assert out == {"deleted": 2000, "batches": 2, "capped": True}


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
    monkeypatch.setattr(retention_router, "require_internal_key", lambda r: None)
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
    monkeypatch.setattr(retention_router, "require_internal_key", lambda r: None)
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
    monkeypatch.setattr(retention_router, "require_internal_key", lambda r: None)
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
