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
    def __init__(self, sole_users):
        self.sole_users = sole_users
        self.statements = []
        self.committed = False

    async def execute(self, stmt, params):
        sql = str(stmt)
        self.statements.append(sql)
        if "cardinality(array_remove" in sql:
            return FakeResult([{"name": n} for n in self.sole_users])
        if "DELETE FROM ai_gateway_endpoints" in sql:
            return FakeResult([(params["id"],)])
        return FakeResult([])

    async def commit(self):
        self.committed = True


def _use(monkeypatch, db):
    @asynccontextmanager
    async def fake_get_db():
        yield db

    monkeypatch.setattr(endpoints_crud, "get_db", fake_get_db)


async def test_refuses_when_a_key_would_lose_its_last_endpoint(monkeypatch):
    db = FakeDb(["Recruitment screening (pilot)"])
    _use(monkeypatch, db)
    with pytest.raises(endpoints_crud.EndpointInUseError) as e:
        await endpoints_crud.delete_endpoint(2, 9)
    assert e.value.key_names == ["Recruitment screening (pilot)"]
    assert not any("UPDATE ai_gateway_virtual_keys" in s or "DELETE FROM" in s for s in db.statements)
    assert db.committed is False


async def test_deletes_when_every_key_keeps_another_endpoint(monkeypatch):
    db = FakeDb([])
    _use(monkeypatch, db)
    assert await endpoints_crud.delete_endpoint(2, 21) is True
    assert any("array_remove(allowed_endpoint_ids, :id)" in s and "UPDATE" in s for s in db.statements)
    assert db.committed is True


def test_the_route_answers_409_naming_the_keys(monkeypatch):
    async def existing(org_id, endpoint_id):
        return {"id": endpoint_id, "display_name": "Recruitment CV summarizer"}

    async def refuse(org_id, endpoint_id):
        raise endpoints_crud.EndpointInUseError(["Demand forecasting batch", "Recruitment screening (pilot)"])

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
    assert "Demand forecasting batch, Recruitment screening (pilot)" in r.json()["detail"]
