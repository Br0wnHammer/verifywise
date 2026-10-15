"""CrewAI adapter: governs every tool call through CrewAI's tool-call hooks.

    from verifywise_agent_control.crewai import enable_crewai_governance

    enable_crewai_governance()
    crew.kickoff()

Registers one ``pre_tool_call`` and one ``post_tool_call`` hook (plus
``execution_start``/``execution_end`` hooks for run ids). CrewAI runs these
hooks on every tool-execution path (native function calling, the text ReAct
loop, parallel tool calls, ``Agent.kickoff``), so no tool can be missed. The
hooks are process-wide: they govern every crew and agent in the process until
``disable()`` is called.

Behaviour verified against crewai 1.15.28:

- A refused call is blocked in the pre hook, so the tool does not run. CrewAI
  still runs the post hooks on a blocked call, and the post hook replaces
  CrewAI's fixed "Tool execution blocked by hook" text with our refusal, so the
  model sees ``Blocked by VerifyWise policy: <reason>`` and the agent continues.
- With ``on_deny="raise"`` the post hook raises :class:`VerifyWiseCrewAIDenied`
  (a ``VerifyWiseDenied`` that is also CrewAI's ``HookAborted``), which CrewAI
  passes through without retrying, so ``kickoff()`` raises it. Any other
  exception raised inside a CrewAI hook is swallowed by CrewAI.
- CrewAI catches tool exceptions itself and hands the error text to the model.
  The adapter does not change that; it records the error on the audit row.

Run id: the active ``vw_session`` id, else a new id per crew kickoff, else the
client's own id (e.g. ``Agent.kickoff`` outside a crew).
"""

from __future__ import annotations

import logging
import threading
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from crewai.hooks import HookAborted, InterceptionPoint, register_hook, unregister_hook

from ._core import default_client
from .client import AgentControlClient
from .decision import Decision, VerifyWiseDenied
from .session import current_session_id, new_session_id

logger = logging.getLogger("verifywise_agent_control")

# How CrewAI hands a tool exception to the model: native function calling and
# the ReAct loop use different texts (crewai 1.15).
_ERROR_MARKERS = (
    "Error executing tool: ",
    "I encountered an error while trying to use the tool. This was the error: ",
)


class VerifyWiseCrewAIDenied(VerifyWiseDenied, HookAborted):
    """``VerifyWiseDenied`` that CrewAI treats as a deliberate stop (``on_deny="raise"``)."""

    def __init__(self, tool_name: str, decision: Decision):
        VerifyWiseDenied.__init__(self, tool_name, decision)
        self.reason = decision.refusal_message
        self.source = "verifywise_agent_control"


@dataclass
class _Pending:
    tool_name: str
    tool_input_id: int
    session_id: str
    call_id: str
    decision: Decision


# Pre → post hand-over. CrewAI runs the pre hook, the tool and the post hook
# in one context (parallel calls each get a copied context), and tools such as
# delegation can nest further calls in between, hence a stack.
_pending: ContextVar[tuple[_Pending, ...]] = ContextVar("verifywise_crewai_pending", default=())
# Run ids of the crew kickoffs in progress in this context (innermost last).
_kickoffs: ContextVar[tuple[str, ...]] = ContextVar("verifywise_crewai_kickoffs", default=())


def _error_text(result: Any) -> str | None:
    if isinstance(result, str):
        text = result.lstrip()
        if any(text.startswith(marker) for marker in _ERROR_MARKERS):
            return text
    return None


class CrewAIGovernance:
    """The registered hooks. Create with :func:`enable_crewai_governance`."""

    def __init__(self, client: AgentControlClient):
        self.client = client
        self._hooks = (
            (InterceptionPoint.EXECUTION_START, self._on_execution_start),
            (InterceptionPoint.EXECUTION_END, self._on_execution_end),
            (InterceptionPoint.PRE_TOOL_CALL, self._before_tool_call),
            (InterceptionPoint.POST_TOOL_CALL, self._after_tool_call),
        )
        self.enabled = False

    def _enable(self) -> None:
        for point, hook in self._hooks:
            register_hook(point, hook)
        self.enabled = True

    def disable(self) -> None:
        """Remove the hooks; later tool calls are no longer checked."""
        for point, hook in self._hooks:
            unregister_hook(point, hook)
        self.enabled = False

    # ── Run ids ────────────────────────────────────────────────────────────

    def _on_execution_start(self, ctx: Any) -> None:
        _kickoffs.set((*_kickoffs.get(), new_session_id()))
        return None  # a non-None return would replace the kickoff inputs

    def _on_execution_end(self, ctx: Any) -> None:
        _kickoffs.set(_kickoffs.get()[:-1])
        return None

    def _session_id(self) -> str:
        kickoffs = _kickoffs.get()
        return current_session_id() or (kickoffs[-1] if kickoffs else self.client.session_id)

    # ── Tool calls ─────────────────────────────────────────────────────────

    def _before_tool_call(self, ctx: Any) -> bool | None:
        tool_name = ctx.tool_name or "unknown"
        session_id = self._session_id()
        call_id = str(uuid.uuid4())
        decision = self.client.check(tool_name, ctx.tool_input or {}, session_id=session_id, call_id=call_id)
        _pending.set(
            (*_pending.get(), _Pending(tool_name, id(ctx.tool_input), session_id, call_id, decision))
        )
        return None if decision.allowed else False

    def _take_pending(self, ctx: Any) -> _Pending | None:
        stack = _pending.get()
        for index in range(len(stack) - 1, -1, -1):
            entry = stack[index]
            if entry.tool_name == ctx.tool_name and entry.tool_input_id == id(ctx.tool_input):
                _pending.set(stack[:index] + stack[index + 1 :])
                return entry
        for index in range(len(stack) - 1, -1, -1):  # input dict was copied: match by name
            if stack[index].tool_name == ctx.tool_name:
                entry = stack[index]
                _pending.set(stack[:index] + stack[index + 1 :])
                return entry
        return None

    def _after_tool_call(self, ctx: Any) -> str | None:
        entry = self._take_pending(ctx)
        if entry is None:
            return None
        if not entry.decision.allowed:
            if self.client.settings.on_deny == "raise":
                raise VerifyWiseCrewAIDenied(entry.tool_name, entry.decision)
            return entry.decision.refusal_message
        try:
            error = _error_text(ctx.raw_tool_result) or _error_text(ctx.tool_result)
            output = None if error else ctx.raw_tool_result
        except Exception:  # noqa: BLE001 - never let result capture break the agent
            error, output = None, None
        self.client.report(
            session_id=entry.session_id,
            call_id=entry.call_id,
            tool_name=entry.tool_name,
            output=output,
            error=error,
        )
        return None


_lock = threading.Lock()
_active: CrewAIGovernance | None = None


def enable_crewai_governance(client: AgentControlClient | None = None) -> CrewAIGovernance:
    """Check every CrewAI tool call in this process with VerifyWise Agent Control.

    Calling it again replaces the previous registration, so hooks are never
    doubled.

    Args:
        client: The client to use. Built from the ``VW_*`` environment variables
            when omitted.

    Returns:
        The registration; call ``.disable()`` to remove it.
    """
    global _active
    with _lock:
        if _active is not None:
            _active.disable()
        _active = CrewAIGovernance(client or default_client())
        _active._enable()
        return _active


def disable_crewai_governance() -> None:
    """Remove the hooks registered by :func:`enable_crewai_governance`, if any."""
    global _active
    with _lock:
        if _active is not None:
            _active.disable()
            _active = None
