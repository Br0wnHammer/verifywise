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


# Machine codes in require_internal_key's error detail, so the caller can tell
# these refusals from a 503 or 401 sent by a proxy or load balancer.
INTERNAL_KEY_NOT_CONFIGURED = "internal_key_not_configured"
INTERNAL_KEY_REJECTED = "internal_key_rejected"


def require_internal_key(request: Request):
    """Like verify_internal_key, but fails closed: with no internal key
    configured the request is refused (503) instead of served. For routes
    that delete data in bulk across organizations.

    Errors carry {"detail": {"message": ..., "code": ...}} with one of the
    codes above."""
    expected = settings.ai_gateway_internal_key
    if not expected:
        logger.error(
            "Refused %s %s: AI_GATEWAY_INTERNAL_KEY is not configured",
            request.method,
            request.url.path,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Internal key not configured",
                "code": INTERNAL_KEY_NOT_CONFIGURED,
            },
        )
    auth = request.headers.get("x-internal-key", "")
    # Compare bytes: hmac.compare_digest raises TypeError for a str with
    # non-ASCII characters, which would surface as a 500. Such a header can
    # never match an ASCII key, so it is simply rejected.
    if not hmac.compare_digest(auth.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(
            status_code=401,
            detail={"message": "Invalid internal key", "code": INTERNAL_KEY_REJECTED},
        )
