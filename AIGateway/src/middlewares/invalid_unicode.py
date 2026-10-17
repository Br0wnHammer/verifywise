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

# A backslash escape: \uXXXX (group 1 holds the hex) or any other escaped
# character, so an escaped backslash ("\\ud83d" in JSON) is consumed whole
# and the "u" after it is not read as an escape.
_ESCAPE = re.compile(r"\\(?:u([0-9a-fA-F]{4})|.)", re.S)

# Bodies of these types are not JSON; every other body is checked, because
# the gateway's routes call request.json() whatever the content type says.
_NON_JSON_MEDIA_PREFIXES = (b"multipart/", b"application/octet-stream")

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
            return not media_type.startswith(_NON_JSON_MEDIA_PREFIXES)
    return True


def _has_lone_surrogate_escape(text: str) -> bool:
    """Whether the text has a \\uD800-\\uDFFF escape that is not half of a
    high+low pair. One linear pass over the escapes, so the common case, an
    emoji sent as an escaped pair, never needs a full JSON parse."""
    pending_high_end = None
    for m in _ESCAPE.finditer(text):
        code = int(m.group(1), 16) if m.group(1) else None
        if pending_high_end is not None:
            if m.start() == pending_high_end and code is not None and 0xDC00 <= code <= 0xDFFF:
                pending_high_end = None
                continue
            return True
        if code is not None and 0xD800 <= code <= 0xDBFF:
            pending_high_end = m.end()
        elif code is not None and 0xDC00 <= code <= 0xDFFF:
            return True
    return pending_high_end is not None


def has_invalid_unicode(body: bytes) -> bool:
    """True when a JSON body cannot be decoded in the encoding json.loads
    detects for it (UTF-8, or UTF-16/32 by its byte pattern), or decodes to a
    string that cannot be encoded as UTF-8 (a lone surrogate). Bodies that
    are not valid JSON are left for the route to reject in its own format."""
    if not body:
        return False
    try:
        text = body.decode(json.detect_encoding(body))
    except UnicodeDecodeError:
        return True
    if not _has_lone_surrogate_escape(text):
        return False
    # Rare: confirm the escape sits in a JSON string the route would accept.
    try:
        parsed = json.loads(text)
    except (ValueError, RecursionError):
        # Not JSON this module can read: the route rejects it in its own format.
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
        del chunks

        if has_invalid_unicode(body):
            await _error_response(scope.get("path", ""))(scope, receive, send)
            return

        replayed = False

        async def replay() -> Message:
            nonlocal replayed, body
            if not replayed:
                replayed = True
                message = {"type": "http.request", "body": body, "more_body": False}
                # Release this copy; a long streamed response must not hold it.
                body = b""
                return message
            return await receive()

        await self.app(scope, replay, send)
