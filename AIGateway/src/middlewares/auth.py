"""Shared authentication middleware for FastAPI routers."""

import hmac
import logging

from fastapi import Request, HTTPException

from config import settings

logger = logging.getLogger(__name__)


def verify_internal_key(request: Request):
    """Verify the request comes from the Express backend."""
    auth = request.headers.get("x-internal-key", "")
    if settings.ai_gateway_internal_key and not hmac.compare_digest(
        auth, settings.ai_gateway_internal_key
    ):
        raise HTTPException(status_code=401, detail="Invalid internal key")


def require_internal_key(request: Request):
    """Like verify_internal_key, but fails closed: with no internal key
    configured the request is refused (503) instead of served. For routes
    that delete data in bulk across organizations."""
    expected = settings.ai_gateway_internal_key
    if not expected:
        logger.error(
            "Refused %s %s: AI_GATEWAY_INTERNAL_KEY is not configured",
            request.method,
            request.url.path,
        )
        raise HTTPException(status_code=503, detail="Internal key not configured")
    auth = request.headers.get("x-internal-key", "")
    if not hmac.compare_digest(auth, expected):
        raise HTTPException(status_code=401, detail="Invalid internal key")
