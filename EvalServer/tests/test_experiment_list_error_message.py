"""
The experiments list must carry error_message, so the experiment tables can
show why a failed run failed (the detail endpoint already returns it).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List

import pytest

from crud.evaluation_logs import get_experiments


class _Result:
    def __init__(self, rows: List[Dict[str, Any]]) -> None:
        self._rows = rows

    def mappings(self) -> List[Dict[str, Any]]:
        return self._rows


class _FakeDb:
    def __init__(self, rows: List[Dict[str, Any]]) -> None:
        self.rows = rows
        self.sql: List[str] = []

    async def execute(self, statement: Any, params: Any = None) -> _Result:
        self.sql.append(str(statement))
        return _Result(self.rows)


@pytest.mark.asyncio
async def test_list_returns_the_failure_reason() -> None:
    now = datetime(2026, 10, 6, 12, 0, 0)
    row = {
        "id": "exp-1",
        "project_id": "p1",
        "name": "Run",
        "description": "Evaluating m with 2 prompts",
        "config": {},
        "status": "failed",
        "results": None,
        "error_message": "No responses generated: 2/2 prompts failed. First error: boom",
        "created_at": now,
        "updated_at": now,
        "started_at": now,
        "completed_at": now,
        "model_inventory_id": None,
    }
    db = _FakeDb([row])

    experiments = await get_experiments(db, organization_id=1)  # type: ignore[arg-type]

    assert "error_message" in db.sql[0]
    assert experiments[0]["error_message"] == row["error_message"]
