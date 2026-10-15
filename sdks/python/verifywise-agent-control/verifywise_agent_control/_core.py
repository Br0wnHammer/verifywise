"""The one governed-call flow every adapter uses: check, run or refuse, report."""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from .client import AgentControlClient, AsyncAgentControlClient
from .decision import Decision, VerifyWiseDenied

logger = logging.getLogger("verifywise_agent_control")

T = TypeVar("T")

# describe(result) -> (output, error): what to record for a tool that returned
# normally. An adapter whose framework turns tool failures into return values
# (e.g. an error ToolMessage) reports them as errors this way.
Describe = Callable[[Any], "tuple[Any, Any]"]
Refuse = Callable[[Decision], Any]

_lock = threading.Lock()
_default_sync: AgentControlClient | None = None
_default_async: AsyncAgentControlClient | None = None


def default_client() -> AgentControlClient:
    """A process-wide client built from the VW_* environment variables."""
    global _default_sync
    with _lock:
        if _default_sync is None:
            _default_sync = AgentControlClient()
        return _default_sync


def default_async_client() -> AsyncAgentControlClient:
    """A process-wide async client built from the VW_* environment variables."""
    global _default_async
    with _lock:
        if _default_async is None:
            _default_async = AsyncAgentControlClient()
        return _default_async


def _refusal(client, tool_name: str, decision: Decision, refuse: Refuse | None) -> Any:
    if client.settings.on_deny == "raise":
        raise VerifyWiseDenied(tool_name, decision)
    return refuse(decision) if refuse else decision.refusal_message


def _describe(describe: Describe | None, result: Any) -> tuple[Any, Any]:
    if describe is None:
        return result, None
    try:
        return describe(result)
    except Exception:  # noqa: BLE001 - never let result capture break the agent
        logger.debug("VerifyWise could not describe a tool result", exc_info=True)
        return result, None


def run_governed(
    client: AgentControlClient,
    *,
    tool_name: str,
    arguments: Any,
    execute: Callable[[], T],
    session_id: str | None = None,
    call_id: str | None = None,
    refuse: Refuse | None = None,
    describe: Describe | None = None,
) -> T | Any:
    """Check a tool call, run it if allowed, report its result.

    Returns the tool's result, or ``refuse(decision)`` (default: the refusal text)
    when the call is refused. Raises only ``VerifyWiseDenied`` (when
    ``on_deny="raise"``) or the tool's own exception, unchanged.
    """
    session_id = session_id or client.session_id
    call_id = call_id or str(uuid.uuid4())
    decision = client.check(tool_name, arguments, session_id=session_id, call_id=call_id)
    if not decision.allowed:
        return _refusal(client, tool_name, decision, refuse)
    try:
        result = execute()
    except Exception as exc:
        client.report(session_id=session_id, call_id=call_id, tool_name=tool_name, error=exc)
        raise
    output, error = _describe(describe, result)
    client.report(session_id=session_id, call_id=call_id, tool_name=tool_name, output=output, error=error)
    return result


async def arun_governed(
    client: AsyncAgentControlClient,
    *,
    tool_name: str,
    arguments: Any,
    execute: Callable[[], Awaitable[T]],
    session_id: str | None = None,
    call_id: str | None = None,
    refuse: Refuse | None = None,
    describe: Describe | None = None,
) -> T | Any:
    """Async version of :func:`run_governed`."""
    session_id = session_id or client.session_id
    call_id = call_id or str(uuid.uuid4())
    decision = await client.check(tool_name, arguments, session_id=session_id, call_id=call_id)
    if not decision.allowed:
        return _refusal(client, tool_name, decision, refuse)
    try:
        result = await execute()
    except Exception as exc:
        await client.report(session_id=session_id, call_id=call_id, tool_name=tool_name, error=exc)
        raise
    output, error = _describe(describe, result)
    await client.report(
        session_id=session_id, call_id=call_id, tool_name=tool_name, output=output, error=error
    )
    return result
