"""HTTP clients for the Agent Control native hook.

``check()`` asks the gateway whether a tool call may run (``POST /v1/mcp/hook``),
waits for a human approval when one is required, and applies the fail modes.
``report()`` records the tool's result (``POST /v1/mcp/hook/result``).

Neither method raises: every network, protocol or internal failure becomes a
Decision chosen by the fail mode (``check``) or a logged warning (``report``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

import httpx

from . import decision as d
from ._version import __version__
from .config import Settings
from .decision import Decision
from .session import current_session_id, new_session_id

logger = logging.getLogger("verifywise_agent_control")

HOOK_PATH = "/v1/mcp/hook"
RESULT_PATH = "/v1/mcp/hook/result"
USER_AGENT = f"verifywise-agent-control/{__version__}"


class _Pending:
    """An approval_required reply: poll ``endpoint`` for the human's decision."""

    def __init__(self, approval_id: str, endpoint: str):
        self.approval_id = approval_id
        self.endpoint = endpoint


def _json_safe(value: Any) -> Any:
    """Round-trip through JSON, stringifying anything JSON can't encode."""
    return json.loads(json.dumps(value, default=str))


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


def _truncate(text: str, max_bytes: int) -> tuple[str, bool]:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text, False
    return raw[:max_bytes].decode("utf-8", "ignore"), True


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
        text, truncated = _truncate(text, self.settings.max_result_bytes)
        response: dict[str, Any] = {key: text}
        if truncated:
            response["truncated"] = True
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
            logger.debug("VerifyWise check failed unexpectedly", exc_info=True)
            return self._fail(tool_name, f"internal error: {type(exc).__name__}")

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
        except httpx.HTTPError as exc:
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
            except httpx.HTTPError:
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
            if response.status_code != 200:
                logger.warning(
                    "VerifyWise did not record the result of tool '%s' (HTTP %s)",
                    tool_name,
                    response.status_code,
                )
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


class AsyncAgentControlClient(_ClientBase):
    """Asynchronous Agent Control client (same behaviour as AgentControlClient)."""

    def __init__(self, *, http_client: httpx.AsyncClient | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._owns_http = http_client is None
        self._http: httpx.AsyncClient | None = http_client
        self._http_loop: asyncio.AbstractEventLoop | None = None
        self._sleep = asyncio.sleep

    def _client(self) -> httpx.AsyncClient:
        # An httpx.AsyncClient's connection pool is bound to the event loop that
        # used it. Our own client is recreated when the loop changes (e.g. several
        # asyncio.run() calls); a supplied client is the caller's to manage.
        if not self._owns_http:
            return self._http
        loop = asyncio.get_running_loop()
        if self._http is None or self._http_loop is not loop or self._http.is_closed:
            self._http = httpx.AsyncClient()
            self._http_loop = loop
        return self._http

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
            logger.debug("VerifyWise check failed unexpectedly", exc_info=True)
            return self._fail(tool_name, f"internal error: {type(exc).__name__}")

    async def _check(self, tool_name, arguments, session_id, call_id) -> Decision:
        if not self.settings.configured:
            return self._fail(tool_name, "VW_GATEWAY_URL or VW_AGENT_KEY not set")
        session_id = session_id or self.session_id
        call_id = call_id or str(uuid.uuid4())
        try:
            response = await self._client().post(
                self.settings.gateway_url + HOOK_PATH,
                content=self._hook_body(tool_name, arguments, session_id, call_id),
                headers=self._headers(session_id),
                timeout=self.settings.timeout,
            )
        except httpx.HTTPError as exc:
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
                response = await self._client().get(
                    url, headers=self._headers(), timeout=self.settings.timeout
                )
            except httpx.HTTPError:
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
            response = await self._client().post(
                self.settings.gateway_url + RESULT_PATH,
                content=self._result_body(session_id, call_id, tool_name, output, error),
                headers=self._headers(session_id),
                timeout=self.settings.timeout,
            )
            if response.status_code != 200:
                logger.warning(
                    "VerifyWise did not record the result of tool '%s' (HTTP %s)",
                    tool_name,
                    response.status_code,
                )
        except Exception as exc:  # noqa: BLE001 - result capture is best-effort
            logger.warning(
                "VerifyWise could not record the result of tool '%s': %s", tool_name, type(exc).__name__
            )

    async def aclose(self) -> None:
        if self._owns_http and self._http is not None:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncAgentControlClient:
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.aclose()
