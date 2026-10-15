"""HTTP clients for the Agent Control native hook.

``check()`` asks the gateway whether a tool call may run (``POST /v1/mcp/hook``),
waits for a human approval when one is required, and applies the fail modes.
``report()`` records the tool's result (``POST /v1/mcp/hook/result``).

Neither method raises. In ``check``, a network failure, timeout, 5xx or
unreadable reply becomes a Decision chosen by the fail mode; a rejected agent
key (HTTP 401/403) and an error inside the SDK itself are always refused,
whatever the fail mode, since neither is a gateway outage. ``report`` only logs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import threading
import time
import uuid
from collections.abc import AsyncIterator, Mapping
from typing import Any

import httpx

from . import decision as d
from ._version import __version__
from .config import GATEWAY_RESULT_CAP_BYTES, MAX_RESULT_BYTES, Settings
from .decision import Decision
from .session import current_session_id, new_session_id

logger = logging.getLogger("verifywise_agent_control")

HOOK_PATH = "/v1/mcp/hook"
RESULT_PATH = "/v1/mcp/hook/result"
USER_AGENT = f"verifywise-agent-control/{__version__}"
KEY_REJECTED_REASON = "VerifyWise rejected the agent key (revoked, expired or invalid)"
AUTH_FAILURES = (401, 403)
_MAX_DEPTH = 64

__all__ = [
    "GATEWAY_RESULT_CAP_BYTES",
    "MAX_RESULT_BYTES",
    "AgentControlClient",
    "AsyncAgentControlClient",
]


class _Pending:
    """An approval_required reply: poll ``endpoint`` for the human's decision."""

    def __init__(self, approval_id: str, endpoint: str):
        self.approval_id = approval_id
        self.endpoint = endpoint


def _text(value: Any) -> str:
    """str(value), else repr(value), else a placeholder. Never raises."""
    for convert in (str, repr):
        try:
            return convert(value)
        except Exception:  # noqa: BLE001 - user objects may raise anything
            continue
    return f"<unrepresentable {type(value).__name__}>"


def _json_key(key: Any) -> str:
    if isinstance(key, str):
        return key
    if key is None or isinstance(key, (bool, int, float)):
        return json.dumps(key)  # what json.dumps does with these keys
    return _text(key)


def _json_safe(value: Any, _path: set[int] | None = None, _depth: int = 0) -> Any:
    """A JSON-encodable copy of ``value``. Never raises.

    Non-string keys are stringified, a container that contains itself becomes
    "<circular reference>", nesting deeper than 64 levels is cut, non-finite
    floats become strings and anything else falls back to str() / repr().
    """
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if not isinstance(value, (Mapping, list, tuple, set, frozenset)):
        return _text(value)
    if _depth >= _MAX_DEPTH:
        return "<nested too deeply>"
    path = _path if _path is not None else set()
    if id(value) in path:
        return "<circular reference>"
    path.add(id(value))
    try:
        if isinstance(value, Mapping):
            return {_json_key(k): _json_safe(v, path, _depth + 1) for k, v in value.items()}
        return [_json_safe(item, path, _depth + 1) for item in value]
    except Exception:  # noqa: BLE001 - e.g. a mapping whose items() raises
        return _text(value)
    finally:
        path.discard(id(value))


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list, tuple, int, float, bool)) or value is None:
        try:
            return json.dumps(value, default=str)
        except (TypeError, ValueError):
            pass
    return str(value)


def _error_text(error: Any) -> str:
    if isinstance(error, BaseException):
        return f"{type(error).__name__}: {error}"
    return _stringify(error)


def _serialized_size(envelope: dict[str, Any]) -> int:
    # Sized exactly as the gateway sizes it: len(json.dumps(tool_response)).
    return len(json.dumps(envelope).encode("utf-8"))


def _result_envelope(key: str, text: str, max_bytes: int) -> dict[str, Any]:
    """``{key: text}``, with text cut so the serialized envelope (including
    ``"truncated": true``) fits in ``max_bytes``. Escapes such as ``\\n`` or
    ``\\u00e9`` count at their serialized size and are never split."""
    envelope: dict[str, Any] = {key: text}
    if _serialized_size(envelope) <= max_bytes:
        return envelope
    text = text[:max_bytes]  # every character serializes to at least one byte
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if _serialized_size({key: text[:mid], "truncated": True}) <= max_bytes:
            low = mid
        else:
            high = mid - 1
    return {key: text[:low], "truncated": True}


def _describe_monitored(tool_name: str, monitored: Any) -> str:
    if not isinstance(monitored, dict):
        return f"VerifyWise monitor mode: tool '{tool_name}' ran, but a policy would have stopped it"
    would = monitored.get("would")
    action = {
        "deny": "would have been denied",
        "approval_required": "would have required approval",
    }.get(would, f"would have been {would or 'stopped'}")
    message = f"VerifyWise monitor mode: tool '{tool_name}' ran, but {action}"
    if monitored.get("reason"):
        message += f": {monitored['reason']}"
    rule = monitored.get("rule")
    if isinstance(rule, dict) and rule.get("name"):
        message += f" (rule: {rule['name']})"
    return message


class _ClientBase:
    """Settings, request building and response interpretation shared by both clients."""

    def __init__(
        self,
        *,
        settings: Settings | None = None,
        session_id: str | None = None,
        gateway_url: str | None = None,
        agent_key: str | None = None,
        fail_mode: str | None = None,
        timeout: float | None = None,
        approval_wait: float | None = None,
        approval_fail_mode: str | None = None,
        approval_poll_interval: float | None = None,
        on_deny: str | None = None,
    ):
        overrides = {
            "gateway_url": gateway_url,
            "agent_key": agent_key,
            "fail_mode": fail_mode,
            "timeout": timeout,
            "approval_wait": approval_wait,
            "approval_fail_mode": approval_fail_mode,
            "approval_poll_interval": approval_poll_interval,
            "on_deny": on_deny,
        }
        self.settings = settings.replace(**overrides) if settings else Settings.from_env(**overrides)
        self._default_session_id = session_id or new_session_id()
        self._clock = time.monotonic

    @property
    def session_id(self) -> str:
        """The run id in effect: the active ``vw_session`` id, else this client's own id.

        Send it as the ``x-vw-agent-run-id`` header on model calls through the
        AI Gateway to correlate them with the tool calls.
        """
        return current_session_id() or self._default_session_id

    # ── Request building ────────────────────────────────────────────────────

    def _headers(self, session_id: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.settings.agent_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        if session_id:
            headers["x-vw-agent-run-id"] = session_id
        return headers

    def _hook_body(self, tool_name: str, arguments: Any, session_id: str, call_id: str) -> bytes:
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            arguments = {"input": arguments}
        payload = {
            "tool_name": str(tool_name),
            "arguments": _json_safe(arguments),
            "session_id": session_id,
            "tool_use_id": call_id,
        }
        return json.dumps(payload).encode("utf-8")

    def _result_body(self, session_id: str, call_id: str, tool_name: str, output: Any, error: Any) -> bytes:
        if error is not None:
            key, text = "error", _error_text(error)
        else:
            key, text = "output", _stringify(output)
        response = _result_envelope(key, text, self.settings.max_result_bytes)
        payload = {
            "session_id": session_id,
            "tool_use_id": call_id,
            "tool_name": str(tool_name),
            "tool_response": response,
        }
        return json.dumps(payload).encode("utf-8")

    # ── Outcomes ────────────────────────────────────────────────────────────

    def _fail(self, tool_name: str, problem: str, status: str = d.GATEWAY_ERROR) -> Decision:
        """Apply the general fail mode (VW_FAIL_MODE) to an infra problem."""
        allowed = self.settings.fail_mode == "open"
        logger.warning(
            "VerifyWise gateway could not decide tool '%s' (%s); fail mode %s: %s",
            tool_name,
            problem,
            self.settings.fail_mode,
            "running it" if allowed else "refusing it",
        )
        reason = None if allowed else f"VerifyWise gateway unavailable ({problem})"
        return Decision(allowed=allowed, status=status, reason=reason, fail_mode_applied=True)

    def _key_rejected(self, tool_name: str, status_code: int, approval_id: str | None = None) -> Decision:
        """HTTP 401/403: the key is revoked, expired or wrong. Never fails open:
        an open fail mode must not turn a revoked key into unlimited access."""
        logger.error(
            "VerifyWise rejected the agent key (HTTP %s) while checking tool '%s'; refusing it. "
            "Check that VW_AGENT_KEY is a current, unrevoked agent key.",
            status_code,
            tool_name,
        )
        return Decision(
            allowed=False, status=d.AUTH_REJECTED, reason=KEY_REJECTED_REASON, approval_id=approval_id
        )

    def _internal_error(self, tool_name: str, exc: BaseException) -> Decision:
        """A bug inside the SDK is not a gateway outage, so the fail mode does not
        apply: the call is refused (closed semantics) and the error logged."""
        logger.error(
            "VerifyWise SDK internal error while checking tool '%s'; refusing it",
            tool_name,
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        return Decision(
            allowed=False,
            status=d.SDK_ERROR,
            reason=f"VerifyWise SDK internal error ({type(exc).__name__})",
        )

    def _approval_fallback(self, tool_name: str, status: str, approval_id: str, problem: str) -> Decision:
        """Apply the approval fail mode (VW_APPROVAL_FAIL_MODE)."""
        allowed = self.settings.approval_fail_mode == "open"
        logger.warning(
            "VerifyWise approval %s for tool '%s' %s; approval fail mode %s: %s",
            approval_id,
            tool_name,
            problem,
            self.settings.approval_fail_mode,
            "running it" if allowed else "refusing it",
        )
        return Decision(
            allowed=allowed,
            status=status,
            reason=None if allowed else f"approval {problem}",
            approval_id=approval_id,
            fail_mode_applied=True,
        )

    def _interpret(self, tool_name: str, response: httpx.Response) -> Decision | _Pending:
        if response.status_code in AUTH_FAILURES:
            return self._key_rejected(tool_name, response.status_code)
        if response.status_code != 200:
            return self._fail(tool_name, f"HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError:
            return self._fail(tool_name, "reply was not JSON")
        if not isinstance(body, dict):
            return self._fail(tool_name, "reply was not a JSON object")

        decision = body.get("decision")
        if decision == "allow":
            monitored = body.get("monitored")
            if monitored:
                logger.warning(_describe_monitored(tool_name, monitored))
            return Decision(
                allowed=True,
                status=d.ALLOW,
                monitored=monitored if isinstance(monitored, dict) else None,
            )
        if decision == "deny":
            reason = body.get("reason") or "policy violation"
            logger.info("VerifyWise denied tool '%s': %s", tool_name, reason)
            return Decision(allowed=False, status=d.DENY, reason=str(reason))
        if decision == "rate_limited":
            return self._fail(tool_name, "rate limited", status=d.RATE_LIMITED)
        if decision == "approval_required":
            approval_id = body.get("approval_id")
            endpoint = body.get("poll_endpoint")
            # The poll URL is always gateway_url + a gateway path, so the agent key
            # is never sent to another host.
            if approval_id is None or not isinstance(endpoint, str) or not endpoint.startswith("/"):
                return self._fail(tool_name, "approval reply missing approval_id/poll_endpoint")
            logger.info(
                "VerifyWise: tool '%s' awaits human approval (id=%s, up to %ss)",
                tool_name,
                approval_id,
                f"{self.settings.approval_wait:g}",
            )
            return _Pending(str(approval_id), endpoint)
        return self._fail(tool_name, f"unexpected decision {decision!r}")

    def _interpret_poll(self, tool_name: str, pending: _Pending, response: httpx.Response) -> Decision | None:
        """A final Decision, or None while the approval is still pending/unreadable."""
        if response.status_code in AUTH_FAILURES:
            return self._key_rejected(tool_name, response.status_code, pending.approval_id)
        if response.status_code != 200:
            return None
        try:
            body = response.json()
        except ValueError:
            return None
        status = body.get("status") if isinstance(body, dict) else None
        if status == "approved":
            logger.info("VerifyWise: approval %s for tool '%s' approved", pending.approval_id, tool_name)
            return Decision(allowed=True, status=d.APPROVED, approval_id=pending.approval_id)
        if status == "denied":
            reason = body.get("decision_reason") or "denied by approver"
            logger.info(
                "VerifyWise: approval %s for tool '%s' denied: %s", pending.approval_id, tool_name, reason
            )
            return Decision(
                allowed=False, status=d.APPROVAL_DENIED, reason=str(reason), approval_id=pending.approval_id
            )
        if status == "expired":
            return self._approval_fallback(tool_name, d.APPROVAL_EXPIRED, pending.approval_id, "expired")
        return None

    def _timed_out(self, tool_name: str, pending: _Pending) -> Decision:
        return self._approval_fallback(
            tool_name,
            d.APPROVAL_TIMEOUT,
            pending.approval_id,
            f"got no decision within {self.settings.approval_wait:g}s",
        )

    @staticmethod
    def _log_report_status(tool_name: str, status_code: int) -> None:
        if status_code in AUTH_FAILURES:
            logger.error(
                "VerifyWise rejected the agent key (HTTP %s) when recording the result of tool '%s'",
                status_code,
                tool_name,
            )
        elif status_code != 200:
            logger.warning(
                "VerifyWise did not record the result of tool '%s' (HTTP %s)", tool_name, status_code
            )


class AgentControlClient(_ClientBase):
    """Synchronous Agent Control client.

    Settings come from the ``VW_*`` environment variables; keyword arguments
    override them. Pass ``settings=`` to start from an existing Settings object.
    """

    def __init__(self, *, http_client: httpx.Client | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client()
        self._sleep = time.sleep

    def check(
        self,
        tool_name: str,
        arguments: Any = None,
        *,
        session_id: str | None = None,
        call_id: str | None = None,
    ) -> Decision:
        """Ask the gateway whether this tool call may run. Never raises."""
        try:
            return self._check(tool_name, arguments, session_id, call_id)
        except Exception as exc:  # noqa: BLE001 - the SDK must never break the agent
            return self._internal_error(tool_name, exc)

    def _check(self, tool_name, arguments, session_id, call_id) -> Decision:
        if not self.settings.configured:
            return self._fail(tool_name, "VW_GATEWAY_URL or VW_AGENT_KEY not set")
        session_id = session_id or self.session_id
        call_id = call_id or str(uuid.uuid4())
        try:
            response = self._http.post(
                self.settings.gateway_url + HOOK_PATH,
                content=self._hook_body(tool_name, arguments, session_id, call_id),
                headers=self._headers(session_id),
                timeout=self.settings.timeout,
            )
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            return self._fail(tool_name, f"gateway unreachable: {type(exc).__name__}")
        outcome = self._interpret(tool_name, response)
        if isinstance(outcome, Decision):
            return outcome
        return self._wait_for_approval(tool_name, outcome)

    def _wait_for_approval(self, tool_name: str, pending: _Pending) -> Decision:
        url = self.settings.gateway_url + pending.endpoint
        deadline = self._clock() + self.settings.approval_wait
        while self._clock() < deadline:
            try:
                response = self._http.get(url, headers=self._headers(), timeout=self.settings.timeout)
            except (httpx.HTTPError, httpx.InvalidURL):
                response = None
            if response is not None:
                outcome = self._interpret_poll(tool_name, pending, response)
                if outcome is not None:
                    return outcome
            self._sleep(min(self.settings.approval_poll_interval, max(deadline - self._clock(), 0)))
        return self._timed_out(tool_name, pending)

    def report(
        self,
        *,
        session_id: str,
        call_id: str,
        tool_name: str,
        output: Any = None,
        error: Any = None,
    ) -> None:
        """Record a tool's output (or error) on its audit row. Never raises."""
        try:
            if not self.settings.configured:
                return
            response = self._http.post(
                self.settings.gateway_url + RESULT_PATH,
                content=self._result_body(session_id, call_id, tool_name, output, error),
                headers=self._headers(session_id),
                timeout=self.settings.timeout,
            )
            self._log_report_status(tool_name, response.status_code)
        except Exception as exc:  # noqa: BLE001 - result capture is best-effort
            logger.warning(
                "VerifyWise could not record the result of tool '%s': %s", tool_name, type(exc).__name__
            )

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> AgentControlClient:
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()


async def _close_with_loop(http: httpx.AsyncClient) -> AsyncIterator[None]:
    """Parked on the loop that owns ``http``. The loop's async-generator
    shutdown (``asyncio.run`` calls it before closing the loop) resumes it,
    which closes the pool on its own loop."""
    try:
        yield
    finally:
        await http.aclose()


class AsyncAgentControlClient(_ClientBase):
    """Asynchronous Agent Control client (same behaviour as AgentControlClient).

    Safe to share between event loops and threads: an ``httpx.AsyncClient``
    pool is bound to the loop that first used it, so this client keeps one pool
    per running loop. A loop's pool is closed when ``asyncio.run`` shuts that
    loop down, and :meth:`aclose` closes every pool still open. A supplied
    ``http_client`` is used as is and left for the caller to close.
    """

    def __init__(self, *, http_client: httpx.AsyncClient | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._owns_http = http_client is None
        self._http: httpx.AsyncClient | None = http_client
        self._pools: dict[asyncio.AbstractEventLoop, tuple[httpx.AsyncClient, Any]] = {}
        self._pools_lock = threading.Lock()
        self._sleep = asyncio.sleep

    def _current_pool(self) -> httpx.AsyncClient | None:
        """The HTTP client the running loop uses, if one exists yet."""
        if not self._owns_http:
            return self._http
        entry = self._pools.get(asyncio.get_running_loop())
        return entry[0] if entry else None

    async def _client(self) -> httpx.AsyncClient:
        if not self._owns_http:
            return self._http
        loop = asyncio.get_running_loop()
        with self._pools_lock:
            # Loops that have closed can't be used again; drop their pools.
            for stale in [lp for lp in self._pools if lp.is_closed()]:
                del self._pools[stale]
            entry = self._pools.get(loop)
            if entry is not None and not entry[0].is_closed:
                return entry[0]
            http = httpx.AsyncClient()
            closer = _close_with_loop(http)
            self._pools[loop] = (http, closer)
        # First iteration registers the generator with this loop's shutdown.
        await closer.__anext__()
        return http

    async def check(
        self,
        tool_name: str,
        arguments: Any = None,
        *,
        session_id: str | None = None,
        call_id: str | None = None,
    ) -> Decision:
        """Ask the gateway whether this tool call may run. Never raises."""
        try:
            return await self._check(tool_name, arguments, session_id, call_id)
        except Exception as exc:  # noqa: BLE001 - the SDK must never break the agent
            return self._internal_error(tool_name, exc)

    async def _check(self, tool_name, arguments, session_id, call_id) -> Decision:
        if not self.settings.configured:
            return self._fail(tool_name, "VW_GATEWAY_URL or VW_AGENT_KEY not set")
        session_id = session_id or self.session_id
        call_id = call_id or str(uuid.uuid4())
        try:
            http = await self._client()
            response = await http.post(
                self.settings.gateway_url + HOOK_PATH,
                content=self._hook_body(tool_name, arguments, session_id, call_id),
                headers=self._headers(session_id),
                timeout=self.settings.timeout,
            )
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            return self._fail(tool_name, f"gateway unreachable: {type(exc).__name__}")
        outcome = self._interpret(tool_name, response)
        if isinstance(outcome, Decision):
            return outcome
        return await self._wait_for_approval(tool_name, outcome)

    async def _wait_for_approval(self, tool_name: str, pending: _Pending) -> Decision:
        url = self.settings.gateway_url + pending.endpoint
        deadline = self._clock() + self.settings.approval_wait
        while self._clock() < deadline:
            try:
                http = await self._client()
                response = await http.get(url, headers=self._headers(), timeout=self.settings.timeout)
            except (httpx.HTTPError, httpx.InvalidURL):
                response = None
            if response is not None:
                outcome = self._interpret_poll(tool_name, pending, response)
                if outcome is not None:
                    return outcome
            await self._sleep(min(self.settings.approval_poll_interval, max(deadline - self._clock(), 0)))
        return self._timed_out(tool_name, pending)

    async def report(
        self,
        *,
        session_id: str,
        call_id: str,
        tool_name: str,
        output: Any = None,
        error: Any = None,
    ) -> None:
        """Record a tool's output (or error) on its audit row. Never raises."""
        try:
            if not self.settings.configured:
                return
            http = await self._client()
            response = await http.post(
                self.settings.gateway_url + RESULT_PATH,
                content=self._result_body(session_id, call_id, tool_name, output, error),
                headers=self._headers(session_id),
                timeout=self.settings.timeout,
            )
            self._log_report_status(tool_name, response.status_code)
        except Exception as exc:  # noqa: BLE001 - result capture is best-effort
            logger.warning(
                "VerifyWise could not record the result of tool '%s': %s", tool_name, type(exc).__name__
            )

    async def aclose(self) -> None:
        """Close every pool this client opened, on whichever loop owns it."""
        if not self._owns_http:
            return
        with self._pools_lock:
            pools = list(self._pools.items())
            self._pools.clear()
        current = asyncio.get_running_loop()
        for loop, (http, closer) in pools:
            if http.is_closed:
                continue
            if loop is current:
                await closer.aclose()
            elif loop.is_running() and not loop.is_closed():
                future = asyncio.run_coroutine_threadsafe(closer.aclose(), loop)
                try:
                    await asyncio.wait_for(asyncio.wrap_future(future), timeout=5)
                except Exception:  # noqa: BLE001 - closing is best-effort
                    logger.debug("VerifyWise could not close an HTTP pool on another loop", exc_info=True)

    async def __aenter__(self) -> AsyncAgentControlClient:
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.aclose()
