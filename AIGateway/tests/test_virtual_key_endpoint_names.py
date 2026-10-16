"""Self-contained tests for the endpoint names attached to each virtual key in
GET /virtual-keys: in the key's order, role-filtered like the endpoints list,
unknown or hidden ids left out (the page shows those by id). No live services."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import crud.virtual_keys as vk_crud  # noqa: E402

ENDPOINTS = [
    {"id": 1, "name": "Collections assistant", "is_active": True, "roles": [1, 4]},
    {"id": 2, "name": "collections-assistant-claude", "is_active": False, "roles": [1, 4]},
    {"id": 3, "name": "M&A assistant", "is_active": True, "roles": [1]},
    {"id": 4, "name": "Open to all", "is_active": True, "roles": []},
]


class FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return self._rows


class FakeDb:
    """Applies the query's id and role filters to ENDPOINTS."""

    def __init__(self):
        self.queries = []

    async def execute(self, _stmt, params):
        self.queries.append(params)
        rows = [e for e in ENDPOINTS if e["id"] in params["ids"]]
        if "role_id" in params:  # empty roles = open to every role, as in the gateway
            rows = [e for e in rows if not e["roles"] or params["role_id"] in e["roles"]]
        return FakeResult([{k: e[k] for k in ("id", "name", "is_active")} for e in rows])


async def _attach(keys, role_id):
    db = FakeDb()
    await vk_crud._attach_endpoint_names(db, 7, role_id, keys)
    return db


async def test_names_follow_the_keys_order_and_skip_unknown_ids():
    keys = [{"allowed_endpoint_ids": [2, 1, 999]}]
    await _attach(keys, role_id=1)
    assert [e["id"] for e in keys[0]["allowed_endpoints"]] == [2, 1]
    assert keys[0]["allowed_endpoints"][0] == {"id": 2, "name": "collections-assistant-claude", "is_active": False}


async def test_endpoints_hidden_from_the_role_are_not_named():
    keys = [{"allowed_endpoint_ids": [1, 3, 4]}]
    await _attach(keys, role_id=4)  # Auditor
    assert [e["id"] for e in keys[0]["allowed_endpoints"]] == [1, 4]


def test_the_role_rule_treats_an_empty_role_list_as_open():
    from crud.endpoints import role_visibility

    clause, params = role_visibility(4)
    assert "cardinality(e.allowed_role_ids) = 0" in clause and "IS NULL" in clause
    assert params == {"role_id": 4}
    assert role_visibility(None) == ("", {})


async def test_one_query_for_only_the_referenced_ids():
    keys = [{"allowed_endpoint_ids": [3, 1]}, {"allowed_endpoint_ids": [1]}, {"allowed_endpoint_ids": None}]
    db = await _attach(keys, role_id=1)
    assert len(db.queries) == 1
    assert db.queries[0]["ids"] == [1, 3]
    assert keys[2]["allowed_endpoints"] == []


async def test_no_query_when_no_key_is_endpoint_restricted():
    keys = [{"allowed_endpoint_ids": []}]
    db = await _attach(keys, role_id=1)
    assert db.queries == []
    assert keys[0]["allowed_endpoints"] == []

