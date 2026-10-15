"""Self-contained tests: the native hook enforces an agent key's tool lists.

No live services: key auth, policy checks, rate limiting and the audit log are
replaced with fakes on the hook router module.
"""

import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import routers.mcp_hook as hook_router
from services.mcp_guardrail_service import ScanResult
from services.mcp_proxy_service import authenticate_agent_key


def _key(allowed=None, blocked=None):
    return {
        "id": 5,
        "organization_id": 9,
        "name": "build-bot",
        "allowed_tools": allowed,
        "blocked_tools": blocked,
        "rate_limit_rpm": None,
    }


@pytest.fixture
def hook(monkeypatch):
    """Wire the hook to fakes and return the mocks the tests assert on."""
    mocks = MagicMock()
    mocks.key = _key()
    mocks.audit = AsyncMock()
    mocks.scan = AsyncMock(return_value=ScanResult())
    mocks.approval = AsyncMock(return_value=None)
    mocks.rate = AsyncMock()

    async def extract(_request):
        return mocks.key

    monkeypatch.setattr(hook_router, "extract_agent_key", extract)
    monkeypatch.setattr(hook_router, "log_tool_call", mocks.audit)
    monkeypatch.setattr(hook_router, "scan_tool_input", mocks.scan)
    monkeypatch.setattr(hook_router, "check_require_approval", mocks.approval)
    monkeypatch.setattr(hook_router, "enforce_mcp_rate_limits", mocks.rate)
    return mocks


async def _call(tool_name):
    request = MagicMock()
    request.json = AsyncMock(
        return_value={"tool_name": tool_name, "arguments": {"q": 1}, "session_id": "s", "tool_use_id": "u"}
    )
    response = await hook_router.mcp_hook(request)
    return json.loads(response.body)


async def test_a_tool_outside_the_allowed_list_is_denied_before_guardrails(hook):
    hook.key = _key(allowed=["Read", "search_*"])

    body = await _call("Bash")

    assert body == {"decision": "deny", "reason": "Tool 'Bash' is not allowed for this agent key"}
    hook.scan.assert_not_awaited()
    hook.approval.assert_not_awaited()
    hook.rate.assert_not_awaited()
    audit = hook.audit.await_args.kwargs
    assert audit["result_status"] == "blocked"
    assert audit["tool_name"] == "Bash"
    assert "Read, search_*" in audit["result_summary"]
    assert "allowed" in audit["result_summary"]


async def test_a_tool_on_the_allowed_list_goes_on_to_guardrails(hook):
    hook.key = _key(allowed=["Read", "search_*"])

    body = await _call("search_docs")

    assert body == {"decision": "allow"}
    hook.scan.assert_awaited_once()
    assert hook.audit.await_args.kwargs["result_status"] == "success"


async def test_a_tool_on_the_blocked_list_is_denied(hook):
    hook.key = _key(blocked=["Bash", "delete_*"])

    body = await _call("delete_user")

    assert body == {"decision": "deny", "reason": "Tool 'delete_user' is not allowed for this agent key"}
    hook.scan.assert_not_awaited()
    audit = hook.audit.await_args.kwargs
    assert audit["result_status"] == "blocked"
    assert "Bash, delete_*" in audit["result_summary"]
    assert "blocked" in audit["result_summary"]


async def test_a_tool_not_on_the_blocked_list_is_allowed(hook):
    hook.key = _key(blocked=["Bash"])

    assert await _call("Read") == {"decision": "allow"}


@pytest.mark.parametrize("allowed,blocked", [(None, None), ([], [])])
async def test_a_key_without_tool_lists_is_unchanged(hook, allowed, blocked):
    hook.key = _key(allowed=allowed, blocked=blocked)

    assert await _call("Bash") == {"decision": "allow"}
    hook.scan.assert_awaited_once()
    hook.rate.assert_awaited_once()


async def test_key_lookup_returns_the_tool_lists(monkeypatch):
    """The hook can only enforce the lists if key auth selects them."""
    from contextlib import asynccontextmanager

    import services.mcp_proxy_service as proxy_service

    executed = []
    row = {
        "id": 1, "organization_id": 2, "name": "k", "allowed_tools": ["Read"], "blocked_tools": None,
        "rate_limit_rpm": None, "is_active": True, "revoked_at": None, "expires_at": None,
    }
    result = MagicMock()
    result.mappings.return_value.fetchone.return_value = row
    db = MagicMock()

    async def execute(stmt, params=None):
        executed.append(str(stmt))
        return result

    db.execute = execute

    @asynccontextmanager
    async def get_db():
        yield db

    monkeypatch.setattr(proxy_service, "get_db", get_db)

    key = await authenticate_agent_key("sk-mcp-test")

    assert "allowed_tools" in executed[0] and "blocked_tools" in executed[0]
    assert key["allowed_tools"] == ["Read"]
