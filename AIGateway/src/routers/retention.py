"""Internal retention endpoints, called by the Express backend's daily job.

Neither route is tenant-scoped: the job runs across organizations, so these
authenticate with the internal key alone.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, StrictInt

from config import settings
from crud import spend as spend_crud
from crud.guardrails import purge_guardrail_logs
from database.db import get_db
from middlewares.auth import verify_internal_key
from sqlalchemy import text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/retention", tags=["retention"])

# Without a body, one call purges every opted-in organization with up to 500
# batches of 1,000 rows per log type per organization.
AUTO_PURGE_MAX_BATCHES = 500
# With an organization_id, one call purges that organization only and stops
# after 100 batches per log type, so a single call stays well inside the
# caller's timeout. The caller repeats the call while a type is capped.
ORG_PURGE_MAX_BATCHES = 100


class PurgeRequest(BaseModel):
    organization_id: StrictInt


@router.get("/config")
async def get_retention_config(request: Request):
    verify_internal_key(request)
    return {"mcp_audit_retention_days": settings.mcp_audit_retention_days}


async def _purge_org(org: dict, max_batches: int) -> dict:
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
            org_id, org["log_retention_days"], max_batches=max_batches
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
                max_batches=max_batches,
            )
        entry["spend_deleted"] = spend["deleted"]
        entry["spend_capped"] = spend["capped"]
    except Exception as error:
        logger.error("Spend log purge failed for org %s: %s", org_id, error)
        entry["spend_error"] = str(error)
    return entry


@router.post("/purge")
async def purge_retention(request: Request, payload: Optional[PurgeRequest] = None):
    """Purge guardrail and spend logs for organizations that opted in.

    With {"organization_id": N}, only that organization is purged (when it
    opted in), with at most ORG_PURGE_MAX_BATCHES batches per log type.
    """
    verify_internal_key(request)

    org_filter = "AND organization_id = :org_id" if payload is not None else ""
    params = {"org_id": payload.organization_id} if payload is not None else {}
    async with get_db() as db:
        result = await db.execute(
            text(
                f"""
                SELECT organization_id, log_retention_days, spend_log_retention_days
                FROM ai_gateway_guardrail_settings
                WHERE auto_purge_enabled {org_filter}
                ORDER BY organization_id
                """
            ),
            params,
        )
        orgs = [dict(row) for row in result.mappings().all()]

    max_batches = (
        ORG_PURGE_MAX_BATCHES if payload is not None else AUTO_PURGE_MAX_BATCHES
    )
    results = []
    for org in orgs:
        results.append(await _purge_org(org, max_batches))
    return {"results": results}
