import sys
import os
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.dialects import postgresql

# Add src to path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from crud.spend import get_spend_by_day


# Regression: the hourly ("1d") query built its "HH:00" labels with a literal
# ':00'. SQLAlchemy text() parses ":00" as a bind parameter, so every
# GET /spend?period=1d failed with "A value is required for bind parameter
# '00'" and the dashboard's 1-day view returned 500. The colon must be escaped.
async def _captured_sql(period: str):
    result = MagicMock()
    result.fetchall.return_value = []
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)
    await get_spend_by_day(db, 1, "2026-09-22", "2026-09-23", period)
    return db.execute.await_args.args[0]


@pytest.mark.parametrize("period", ["1d", "7d", "30d", "90d"])
async def test_only_expected_bind_params(period):
    sql = await _captured_sql(period)
    assert set(sql._bindparams) == {"org_id", "start_date", "end_date"}


async def test_hourly_label_keeps_literal_colon():
    sql = await _captured_sql("1d")
    compiled = str(sql.compile(dialect=postgresql.dialect()))
    assert "|| ':00'" in compiled
