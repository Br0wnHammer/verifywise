"""Deleting an endpoint must not silently widen a virtual key: an empty
allowed_endpoint_ids means "every endpoint" to the gateway, so the delete is
refused while a key that is not revoked allows only that endpoint.
No live services."""

import os
import sys
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import crud.endpoints as endpoints_crud  # noqa: E402
import routers.endpoints as endpoints_router  # noqa: E402


class FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeDb:
    """Answers the strip UPDATE with each key's name and how many endpoints it
    has left, as Postgres' RETURNING would."""

    def __init__(self, remaining_by_key):
        self.remaining_by_key = remaining_by_key
        self.statements = []
        self.committed = False
        self.rolled_back = False

    async def execute(self, stmt, params):
        sql = str(stmt)
        self.statements.append(sql)
        if "UPDATE ai_gateway_virtual_keys" in sql:
            assert "revoked_at IS NULL" in sql and "RETURNING" in sql
            return FakeResult([{"name": n, "remaining": r} for n, r in self.remaining_by_key.items()])
        if "DELETE FROM ai_gateway_endpoints" in sql:
            return FakeResult([(params["id"],)])
        return FakeResult([])

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back = True


def _use(monkeypatch, db):
    @asynccontextmanager
    async def fake_get_db():
        yield db

    monkeypatch.setattr(endpoints_crud, "get_db", fake_get_db)


async def test_refuses_and_rolls_back_when_a_key_would_lose_its_last_endpoint(monkeypatch):
    db = FakeDb({"Support bot": 1, "Recruitment screening (pilot)": 0})
    _use(monkeypatch, db)
    with pytest.raises(endpoints_crud.EndpointInUseError) as e:
        await endpoints_crud.delete_endpoint(2, 9)
    assert e.value.key_names == ["Recruitment screening (pilot)"]
    assert db.rolled_back is True and db.committed is False
    assert not any("DELETE FROM" in s for s in db.statements)


async def test_deletes_when_every_key_keeps_another_endpoint(monkeypatch):
    db = FakeDb({"Collections assistant (pilot)": 1})
    _use(monkeypatch, db)
    assert await endpoints_crud.delete_endpoint(2, 21) is True
    assert any("DELETE FROM ai_gateway_endpoints" in s for s in db.statements)
    assert db.committed is True and db.rolled_back is False


def test_the_route_answers_409_naming_the_keys(monkeypatch):
    async def existing(org_id, endpoint_id):
        return {"id": endpoint_id, "display_name": "Recruitment CV summarizer"}

    async def refuse(org_id, endpoint_id):
        raise endpoints_crud.EndpointInUseError([f"Key {i}" for i in range(1, 8)])

    monkeypatch.setattr(endpoints_crud, "get_endpoint_by_id", existing)
    monkeypatch.setattr(endpoints_crud, "delete_endpoint", refuse)
    app = FastAPI()

    @app.middleware("http")
    async def tenant(request: Request, call_next):
        request.state.organization_id = 2
        request.state.user_id = 1
        request.state.role = "Admin"
        return await call_next(request)

    app.include_router(endpoints_router.router)
    r = TestClient(app).delete("/endpoints/9")
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert "Key 1, Key 2, Key 3, Key 4, Key 5 and 2 more." in detail
    assert "Key 6" not in detail
