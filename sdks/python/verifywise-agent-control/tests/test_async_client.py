import asyncio

import httpx
import pytest
from conftest import GATEWAY, HOOK, KEY, RESULT, body_of

from verifywise_agent_control import AsyncAgentControlClient

POLL = f"{GATEWAY}/v1/mcp/approvals/7/status"
APPROVAL = {"decision": "approval_required", "approval_id": 7, "poll_endpoint": "/v1/mcp/approvals/7/status"}


async def test_allow(gateway, make_async_client):
    route = gateway.post(HOOK).respond(200, json={"decision": "allow"})

    decision = await make_async_client().check("search", {"q": 1}, session_id="r", call_id="c")

    assert decision.allowed
    assert route.calls.last.request.headers["authorization"] == f"Bearer {KEY}"
    assert body_of(route.calls.last) == {
        "tool_name": "search",
        "arguments": {"q": 1},
        "session_id": "r",
        "tool_use_id": "c",
    }


async def test_deny(gateway, make_async_client):
    gateway.post(HOOK).respond(200, json={"decision": "deny", "reason": "nope"})
    decision = await make_async_client().check("x", {})
    assert not decision.allowed and decision.reason == "nope"


@pytest.mark.parametrize("mode,allowed", [("open", True), ("closed", False)])
async def test_unreachable_follows_fail_mode(gateway, make_async_client, mode, allowed):
    gateway.post(HOOK).mock(side_effect=httpx.ConnectError("down"))
    assert (await make_async_client(fail_mode=mode).check("x", {})).allowed is allowed


async def test_approval_approved(gateway, make_async_client, clock):
    gateway.post(HOOK).respond(200, json=APPROVAL)
    gateway.get(POLL).side_effect = [
        httpx.Response(200, json={"status": "pending"}),
        httpx.Response(200, json={"status": "approved"}),
    ]

    decision = await make_async_client().check("deploy", {})

    assert decision.allowed and decision.status == "approved"
    assert clock.sleeps == [2.0]


async def test_approval_denied(gateway, make_async_client):
    gateway.post(HOOK).respond(200, json=APPROVAL)
    gateway.get(POLL).respond(200, json={"status": "denied"})
    decision = await make_async_client().check("deploy", {})
    assert not decision.allowed and decision.status == "approval_denied"


async def test_approval_timeout(gateway, make_async_client):
    gateway.post(HOOK).respond(200, json=APPROVAL)
    gateway.get(POLL).respond(200, json={"status": "pending"})

    decision = await make_async_client(approval_wait=4).check("deploy", {})

    assert not decision.allowed and decision.status == "approval_timeout"


async def test_report(gateway, make_async_client):
    route = gateway.post(RESULT).respond(200, json={})
    await make_async_client().report(session_id="s", call_id="c", tool_name="t", output="done")
    assert body_of(route.calls.last)["tool_response"] == {"output": "done"}


async def test_report_never_raises(gateway, make_async_client):
    gateway.post(RESULT).mock(side_effect=httpx.ConnectError("down"))
    assert await make_async_client().report(session_id="s", call_id="c", tool_name="t", output="x") is None


def test_works_across_event_loops(gateway):
    """A client reused by several asyncio.run() calls must not keep a dead loop's pool."""
    gateway.post(HOOK).respond(200, json={"decision": "allow"})
    client = AsyncAgentControlClient(gateway_url=GATEWAY, agent_key=KEY)

    assert asyncio.run(client.check("x", {})).allowed
    assert asyncio.run(client.check("x", {})).allowed


async def test_async_context_manager_closes(gateway):
    gateway.post(HOOK).respond(200, json={"decision": "allow"})
    async with AsyncAgentControlClient(gateway_url=GATEWAY, agent_key=KEY) as client:
        await client.check("x", {})
        http = client._http
    assert http.is_closed
