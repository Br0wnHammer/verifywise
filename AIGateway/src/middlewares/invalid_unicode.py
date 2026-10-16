"""Reject JSON request bodies that cannot be represented as UTF-8.

JSON lets a string carry a lone UTF-16 surrogate escape such as "\\ud83d".
``json.loads`` accepts it, but the resulting Python string cannot be encoded
as UTF-8, so the request later fails with UnicodeEncodeError (a 500) when a
route echoes it in a response, stores it in Postgres or logs it. A body that
is not valid UTF-8 at all fails the same way inside ``request.json()``.

This middleware checks JSON bodies once, before any route runs, and answers
400 instead. It is plain ASGI (not BaseHTTPMiddleware) so responses, streamed
ones included, pass through untouched; only the request body is buffered and
replayed, which every JSON route does anyway when it parses the body.
"""

import json
import re

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

INVALID_CHARACTER_DETAIL = "Request contains an invalid character"

# A \uXXXX escape in the surrogate range (D800–DFFF). Cheap prefilter: only
# bodies that contain one are parsed here. A valid pair ("😀")
# also matches, and passes once parsed because it decodes to one character.
_SURROGATE_ESCAPE = re.compile(rb"\\u[dD][89abcdefABCDEF][0-9a-fA-F]{2}")

# The MCP JSON-RPC endpoint reports malformed input as a JSON-RPC parse error
# with HTTP 200 (routers/mcp_proxy.py); keep that contract for its clients.
_JSONRPC_PATHS = frozenset({"/v1/mcp"})

_BODY_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _is_json_request(scope: Scope) -> bool:
    if scope.get("method") not in _BODY_METHODS:
        return False
    for name, value in scope.get("headers", []):
        if name == b"content-type":
            media_type = value.split(b";", 1)[0].strip().lower()
            return media_type == b"application/json" or media_type.endswith(b"+json")
    # No content type: routes parse the body as JSON regardless.
    return True


def has_invalid_unicode(body: bytes) -> bool:
    """True when a JSON body is not valid UTF-8 or decodes to a string that
    cannot be encoded as UTF-8 (a lone surrogate). Bodies that are not valid
    JSON are left for the route to reject in its own format."""
    if not body:
        return False
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return True
    if not _SURROGATE_ESCAPE.search(body):
        return False
    try:
        parsed = json.loads(text)
    except ValueError:
        return False
    try:
        json.dumps(parsed, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        return True
    return False


def _error_response(path: str) -> JSONResponse:
    if path in _JSONRPC_PATHS:
        return JSONResponse(
            content={
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": INVALID_CHARACTER_DETAIL},
            },
            status_code=200,
        )
    return JSONResponse(content={"detail": INVALID_CHARACTER_DETAIL}, status_code=400)


class InvalidUnicodeMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _is_json_request(scope):
            await self.app(scope, receive, send)
            return

        chunks: list[bytes] = []
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return  # client went away before sending the whole body
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)

        if has_invalid_unicode(body):
            await _error_response(scope.get("path", ""))(scope, receive, send)
            return

        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
