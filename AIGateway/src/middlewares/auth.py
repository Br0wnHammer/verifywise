"""Shared authentication for the internal API.

Every router mounted under /internal is included with include_internal_router,
which attaches verify_internal_key as a router-level dependency. A route
cannot forget the check, and it runs before the request body is validated.
"""

import hmac
import logging
import time

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request

from config import settings

logger = logging.getLogger(__name__)

# Machine codes in the error detail, so the caller can tell these refusals
# from a 503 or 401 sent by a proxy or load balancer.
INTERNAL_KEY_NOT_CONFIGURED = "internal_key_not_configured"
INTERNAL_KEY_REJECTED = "internal_key_rejected"

# A rejected key is logged at most once per path in this window.
REJECTED_KEY_LOG_INTERVAL_SECONDS = 60.0
_rejected_logged_at: dict[str, float] = {}
_missing_key_logged = False


def keys_match(provided: str, expected: str) -> bool:
    """Constant-time comparison of two keys as UTF-8 bytes.

    hmac.compare_digest raises TypeError for a str with non-ASCII characters,
    which would surface as a 500; such a header can never match an ASCII key,
    so as bytes it is simply a mismatch."""
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def _log_missing_key_once(request: Request) -> None:
    global _missing_key_logged
    if _missing_key_logged:
        return
    _missing_key_logged = True
    logger.error(
        "Refusing internal requests (first: %s %s): AI_GATEWAY_INTERNAL_KEY is not "
        "configured. Every internal route answers 503 until it is set.",
        request.method,
        request.url.path,
    )


def _log_rejected_key(request: Request) -> None:
    """Warn about a rejected key, at most once a minute per path. Only the
    method and path are logged, never the key or the header value."""
    path = request.url.path
    now = time.monotonic()
    last = _rejected_logged_at.get(path)
    if last is not None and now - last < REJECTED_KEY_LOG_INTERVAL_SECONDS:
        return
    _rejected_logged_at[path] = now
    logger.warning("Rejected internal request %s %s: invalid internal key", request.method, path)


def verify_internal_key(request: Request) -> None:
    """Verify the request comes from the Express backend. Fails closed:

    - no internal key configured (empty or whitespace, trimmed by settings):
      503 with code internal_key_not_configured, and the request is not
      served. Defence in depth: the gateway already refuses to start without
      a key (app.py). Logged once per process.
    - a missing, wrong or non-ASCII x-internal-key header: 401 with code
      internal_key_rejected. Logged as a rate-limited warning.

    Errors carry {"detail": {"message": ..., "code": ...}}. Used as a
    router-level dependency through include_internal_router."""
    expected = settings.ai_gateway_internal_key
    if not expected:
        _log_missing_key_once(request)
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Internal key not configured",
                "code": INTERNAL_KEY_NOT_CONFIGURED,
            },
        )
    auth = request.headers.get("x-internal-key", "")
    if not keys_match(auth, expected):
        _log_rejected_key(request)
        raise HTTPException(
            status_code=401,
            detail={"message": "Invalid internal key", "code": INTERNAL_KEY_REJECTED},
        )


def include_internal_router(app: FastAPI, router: APIRouter, **kwargs) -> None:
    """Mount a router under /internal with the internal key check on every
    route it has, including routes added later."""
    dependencies = [Depends(verify_internal_key), *kwargs.pop("dependencies", [])]
    app.include_router(router, prefix="/internal", dependencies=dependencies, **kwargs)
