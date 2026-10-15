"""The one governed-call flow every adapter uses: check, run or refuse, report."""

from __future__ import annotations

import inspect
import logging
import threading
import uuid
import weakref
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from . import decision as d
from .client import AgentControlClient, AsyncAgentControlClient, arguments_changed
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
# A client's counterpart of the other kind, built once from its settings, so
# adapters that need both never build a new client per instance.
_async_twins: weakref.WeakKeyDictionary[AgentControlClient, AsyncAgentControlClient] = (
    weakref.WeakKeyDictionary()
)
_sync_twins: weakref.WeakKeyDictionary[AsyncAgentControlClient, AgentControlClient] = (
    weakref.WeakKeyDictionary()
)


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


def async_client_for(client: AgentControlClient) -> AsyncAgentControlClient:
    """The shared async client with ``client``'s settings."""
    with _lock:
        twin = _async_twins.get(client)
        if twin is None:
            twin = _async_twins[client] = AsyncAgentControlClient(settings=client.settings)
        return twin


def sync_client_for(client: AsyncAgentControlClient) -> AgentControlClient:
    """The shared sync client with ``client``'s settings."""
    with _lock:
        twin = _sync_twins.get(client)
        if twin is None:
            twin = _sync_twins[client] = AgentControlClient(settings=client.settings)
        return twin


def _refusal(client, tool_name: str, decision: Decision, refuse: Refuse | None) -> Any:
    if client.settings.on_deny == "raise":
        raise VerifyWiseDenied(tool_name, decision)
    return refuse(decision) if refuse else decision.refusal_message


ARGUMENTS_CHANGED_REASON = "arguments changed after VerifyWise checked them; the tool was not run"


def _changed_since_check(tool_name: str, decision: Decision, current: Any) -> Decision | None:
    """A refusal when the arguments about to run differ from the checked ones.

    The gateway's verdict covers only the arguments it saw. If anything
    (another thread, middleware, the framework) changed them since, running
    the tool would run unchecked input.
    """
    if not arguments_changed(decision, current):
        return None
    logger.error(
        "VerifyWise: the arguments of tool '%s' changed after they were checked; refusing it", tool_name
    )
    return Decision(allowed=False, status=d.ARGUMENTS_CHANGED, reason=ARGUMENTS_CHANGED_REASON)


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
    current_arguments: Callable[[], Any] | None = None,
) -> T | Any:
    """Check a tool call, run it if allowed, report its result.

    ``execute`` must run the tool with the very arguments passed here (the same
    object, not a copy). Right before it runs, the arguments (or
    ``current_arguments()``, for adapters that read them from a framework
    object) are compared with what the gateway checked; a difference refuses
    the call.

    Returns the tool's result, or ``refuse(decision)`` (default: the refusal text)
    when the call is refused. Raises only ``VerifyWiseDenied`` (when
    ``on_deny="raise"``) or the tool's own exception, unchanged.
    """
    session_id = session_id or client.session_id
    call_id = call_id or str(uuid.uuid4())
    decision = client.check(tool_name, arguments, session_id=session_id, call_id=call_id)
    if not decision.allowed:
        return _refusal(client, tool_name, decision, refuse)
    changed = _changed_since_check(
        tool_name, decision, current_arguments() if current_arguments else arguments
    )
    if changed:
        client.report(session_id=session_id, call_id=call_id, tool_name=tool_name, error=changed.reason)
        return _refusal(client, tool_name, changed, refuse)
    try:
        result = execute()
    except Exception as exc:
        client.report(session_id=session_id, call_id=call_id, tool_name=tool_name, error=exc)
        raise
    if inspect.isawaitable(result):
        # An async tool reached the sync path: nothing ran, so don't report a
        # coroutine object as its output.
        if inspect.iscoroutine(result):
            result.close()
        error = TypeError(
            f"tool '{tool_name}' returned an awaitable on the synchronous path; "
            "make it an async def (or an object with an async __call__) and govern it "
            "with an AsyncAgentControlClient"
        )
        client.report(session_id=session_id, call_id=call_id, tool_name=tool_name, error=error)
        raise error
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
    current_arguments: Callable[[], Any] | None = None,
) -> T | Any:
    """Async version of :func:`run_governed`."""
    session_id = session_id or client.session_id
    call_id = call_id or str(uuid.uuid4())
    decision = await client.check(tool_name, arguments, session_id=session_id, call_id=call_id)
    if not decision.allowed:
        return _refusal(client, tool_name, decision, refuse)
    changed = _changed_since_check(
        tool_name, decision, current_arguments() if current_arguments else arguments
    )
    if changed:
        await client.report(session_id=session_id, call_id=call_id, tool_name=tool_name, error=changed.reason)
        return _refusal(client, tool_name, changed, refuse)
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
