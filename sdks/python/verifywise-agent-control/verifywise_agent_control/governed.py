"""Govern plain Python functions: ``@governed`` and ``govern_tool()``.

For custom agents without a supported framework. Each call is checked with the
gateway first; a refused call returns the refusal text instead of running.
"""

from __future__ import annotations

import functools
import inspect
from collections.abc import Callable
from typing import Any, TypeVar, overload

from ._core import arun_governed, default_async_client, default_client, run_governed
from .client import AgentControlClient, AsyncAgentControlClient

F = TypeVar("F", bound=Callable[..., Any])


def _call_arguments(signature: inspect.Signature | None, args: tuple, kwargs: dict) -> dict[str, Any]:
    """The call's arguments by parameter name (``**kwargs`` merged in)."""
    if signature is not None:
        try:
            bound = signature.bind(*args, **kwargs)
        except TypeError:
            pass
        else:
            out: dict[str, Any] = {}
            for name, value in bound.arguments.items():
                kind = signature.parameters[name].kind
                if kind is inspect.Parameter.VAR_KEYWORD:
                    out.update(value)
                elif kind is inspect.Parameter.VAR_POSITIONAL:
                    out[name] = list(value)
                else:
                    out[name] = value
            return out
    return {"args": list(args), "kwargs": dict(kwargs)}


def _wrap(fn: F, client: AgentControlClient | AsyncAgentControlClient | None, name: str | None) -> F:
    tool_name = name or getattr(fn, "__name__", "tool")
    try:
        signature: inspect.Signature | None = inspect.signature(fn)
    except (TypeError, ValueError):
        signature = None

    if inspect.iscoroutinefunction(fn):
        if client is not None and not isinstance(client, AsyncAgentControlClient):
            raise TypeError("an async function needs an AsyncAgentControlClient")

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            return await arun_governed(
                client or default_async_client(),
                tool_name=tool_name,
                arguments=_call_arguments(signature, args, kwargs),
                execute=lambda: fn(*args, **kwargs),
            )

        return async_wrapper  # type: ignore[return-value]

    if client is not None and not isinstance(client, AgentControlClient):
        raise TypeError("a regular function needs an AgentControlClient")

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        return run_governed(
            client or default_client(),
            tool_name=tool_name,
            arguments=_call_arguments(signature, args, kwargs),
            execute=lambda: fn(*args, **kwargs),
        )

    return wrapper  # type: ignore[return-value]


@overload
def governed(fn: F) -> F: ...


@overload
def governed(
    fn: None = None,
    *,
    client: AgentControlClient | AsyncAgentControlClient | None = None,
    name: str | None = None,
) -> Callable[[F], F]: ...


def governed(
    fn: Callable[..., Any] | None = None,
    *,
    client: AgentControlClient | AsyncAgentControlClient | None = None,
    name: str | None = None,
) -> Any:
    """Check every call of the decorated function with VerifyWise Agent Control.

    Works on regular and ``async`` functions, bare (``@governed``) or with options
    (``@governed(client=..., name=...)``). Without ``client`` a shared client is
    built from the ``VW_*`` environment variables.

    Args:
        client: An ``AgentControlClient`` (regular functions) or
            ``AsyncAgentControlClient`` (async functions).
        name: The tool name reported to the gateway; defaults to the function name.
    """
    if fn is not None:
        return _wrap(fn, client, name)
    return lambda f: _wrap(f, client, name)


def govern_tool(
    fn: F,
    *,
    client: AgentControlClient | AsyncAgentControlClient | None = None,
    name: str | None = None,
) -> F:
    """Return a governed version of an existing function (``governed`` as a call)."""
    return _wrap(fn, client, name)
