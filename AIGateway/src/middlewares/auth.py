"""Shared authentication middleware for FastAPI routers."""

import hmac
import logging

from fastapi import Request, HTTPException

from config import settings

logger = logging.getLogger(__name__)


def keys_match(provided: str, expected: str) -> bool:
    """Constant-time comparison of two keys as UTF-8 bytes.

    hmac.compare_digest raises TypeError for a str with non-ASCII characters,
    which would surface as a 500; such a header can never match an ASCII key,
    so as bytes it is simply a mismatch."""
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


# Machine codes in the error detail, so the caller can tell these refusals
# from a 503 or 401 sent by a proxy or load balancer.
INTERNAL_KEY_NOT_CONFIGURED = "internal_key_not_configured"
INTERNAL_KEY_REJECTED = "internal_key_rejected"


def verify_internal_key(request: Request):
    """Verify the request comes from the Express backend. The one check for
    every internal route, and it fails closed:

    - no internal key configured (empty or whitespace, trimmed by settings):
      503 with code internal_key_not_configured, and the request is not
      served. The gateway already refuses to start without a key (app.py),
      so this only guards against that check being bypassed.
    - a missing, wrong or non-ASCII x-internal-key header: 401 with code
      internal_key_rejected.

    Errors carry {"detail": {"message": ..., "code": ...}}."""
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
    if not keys_match(auth, expected):
        raise HTTPException(
            status_code=401,
            detail={"message": "Invalid internal key", "code": INTERNAL_KEY_REJECTED},
        )
