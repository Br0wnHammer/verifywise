"""Internal retention endpoints, called by the Express backend's daily job.

Neither route is tenant-scoped: the job runs across organizations, so these
authenticate with the internal key alone.
"""

import logging

from fastapi import APIRouter, Request

from config import settings
from crud import spend as spend_crud
from crud.guardrails import purge_guardrail_logs
from database.db import get_db
from middlewares.auth import verify_internal_key
from sqlalchemy import text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/retention", tags=["retention"])

# The daily job allows more than the manual purge: 500 batches of 1,000 rows
# per log type per organization per run.
AUTO_PURGE_MAX_BATCHES = 500


@router.get("/config")
async def get_retention_config(request: Request):
    verify_internal_key(request)
    return {"mcp_audit_retention_days": settings.mcp_audit_retention_days}


@router.post("/purge")
async def purge_retention(request: Request):
    """Purge guardrail and spend logs for every organization that opted in."""
    verify_internal_key(request)

    async with get_db() as db:
        result = await db.execute(
            text(
                """
                SELECT organization_id, log_retention_days, spend_log_retention_days
                FROM ai_gateway_guardrail_settings
                WHERE auto_purge_enabled
                ORDER BY organization_id
                """
            )
        )
        orgs = [dict(row) for row in result.mappings().all()]

    results = []
    for org in orgs:
        org_id = org["organization_id"]
        entry = {
            "organization_id": org_id,
            "guardrail_deleted": 0,
            "guardrail_capped": False,
            "spend_deleted": 0,
            "spend_capped": False,
        }
        # Each log type is purged and reported on its own, so one failure
        # does not mark the other as failed too.
        try:
            guardrail = await purge_guardrail_logs(
                org_id, org["log_retention_days"], max_batches=AUTO_PURGE_MAX_BATCHES
            )
            entry["guardrail_deleted"] = guardrail["deleted"]
            entry["guardrail_capped"] = guardrail["capped"]
        except Exception as error:
            logger.error("Guardrail log purge failed for org %s: %s", org_id, error)
            entry["guardrail_error"] = str(error)
        try:
            async with get_db() as db:
                spend = await spend_crud.purge_spend_logs(
                    db,
                    org_id,
                    org["spend_log_retention_days"],
                    max_batches=AUTO_PURGE_MAX_BATCHES,
                )
            entry["spend_deleted"] = spend["deleted"]
            entry["spend_capped"] = spend["capped"]
        except Exception as error:
            logger.error("Spend log purge failed for org %s: %s", org_id, error)
            entry["spend_error"] = str(error)
        results.append(entry)

    return {"results": results}
