"""OpenAI tool calling through the virtual-key proxy (/v1/chat/completions).

Self-contained: no live gateway, backend or database. Covers the request
fields reaching the provider call, the cache key telling tool requests apart,
guardrails scanning tool results, and the logged response text of a tool call.
"""

import hashlib
import json
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import services.proxy_service as proxy_service  # noqa: E402
from routers.proxy import ProxyChatRequest, _build_llm_kwargs, _response_text  # noqa: E402
from services.cache_service import generate_cache_key  # noqa: E402

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookup_account",
            "description": "Fetch a customer account.",
            "parameters": {
                "type": "object",
                "properties": {"account_id": {"type": "string"}},
                "required": ["account_id"],
            },
        },
    }
]

TOOL_CALLS = [
    {
        "id": "call_1",
        "type": "function",
        "function": {"name": "lookup_account", "arguments": '{"account_id": "4471"}'},
    }
]

ENDPOINT = {"temperature": None, "max_tokens": None}


# ─── Request fields reach the provider call ──────────────────────────────────

def test_request_keeps_tool_fields():
    body = ProxyChatRequest(
        model="collections",
        messages=[{"role": "user", "content": "hi"}],
        tools=TOOLS,
        tool_choice="auto",
        parallel_tool_calls=False,
    )
    assert body.tools == TOOLS
    assert body.tool_choice == "auto"
    assert body.parallel_tool_calls is False


def test_tool_fields_are_forwarded_to_the_provider_call():
    body = ProxyChatRequest(
        model="collections",
        messages=[{"role": "user", "content": "hi"}],
        tools=TOOLS,
        tool_choice={"type": "function", "function": {"name": "lookup_account"}},
        parallel_tool_calls=False,
    )
    kwargs = _build_llm_kwargs(body, ENDPOINT)
    assert kwargs["tools"] == TOOLS
    assert kwargs["tool_choice"] == {"type": "function", "function": {"name": "lookup_account"}}
    assert kwargs["parallel_tool_calls"] is False


def test_plain_request_sends_no_tool_fields():
    body = ProxyChatRequest(model="collections", messages=[{"role": "user", "content": "hi"}])
    kwargs = _build_llm_kwargs(body, ENDPOINT)
    assert "tools" not in kwargs
    assert "tool_choice" not in kwargs
    assert "parallel_tool_calls" not in kwargs


def test_endpoint_defaults_still_apply():
    body = ProxyChatRequest(model="collections", messages=[{"role": "user", "content": "hi"}])
    kwargs = _build_llm_kwargs(body, {"temperature": "0.2", "max_tokens": 400})
    assert kwargs == {"temperature": 0.2, "max_tokens": 400}


# ─── Cache key ───────────────────────────────────────────────────────────────

def _legacy_key(model, messages, temperature, max_tokens):
    canonical = json.dumps(
        {
            "model": model,
            "messages": [{"role": m.get("role", ""), "content": m.get("content", "")} for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
        },
        sort_keys=True,
        ensure_ascii=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def test_plain_request_cache_key_is_unchanged():
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "hello"}]
    assert generate_cache_key("gpt-4o", msgs, 0.7, 1000) == _legacy_key("gpt-4o", msgs, 0.7, 1000)


def test_tools_change_the_cache_key():
    msgs = [{"role": "user", "content": "hello"}]
    assert generate_cache_key("gpt-4o", msgs, 0.7, 1000) != generate_cache_key(
        "gpt-4o", msgs, 0.7, 1000, tools=TOOLS
    )


def test_tool_choice_changes_the_cache_key():
    msgs = [{"role": "user", "content": "hello"}]
    auto = generate_cache_key("gpt-4o", msgs, 0.7, 1000, tools=TOOLS, tool_choice="auto")
    none = generate_cache_key("gpt-4o", msgs, 0.7, 1000, tools=TOOLS, tool_choice="none")
    assert auto != none


def test_assistant_tool_calls_change_the_cache_key():
    base = [{"role": "user", "content": "hello"}]
    a = base + [{"role": "assistant", "content": None, "tool_calls": TOOL_CALLS}]
    other = [{**TOOL_CALLS[0], "function": {"name": "lookup_account", "arguments": '{"account_id": "9999"}'}}]
    b = base + [{"role": "assistant", "content": None, "tool_calls": other}]
    assert generate_cache_key("gpt-4o", a, 0.7, 1000) != generate_cache_key("gpt-4o", b, 0.7, 1000)


def test_tool_call_id_changes_the_cache_key():
    a = [{"role": "tool", "tool_call_id": "call_1", "content": "ok"}]
    b = [{"role": "tool", "tool_call_id": "call_2", "content": "ok"}]
    assert generate_cache_key("gpt-4o", a, 0.7, 1000) != generate_cache_key("gpt-4o", b, 0.7, 1000)


# ─── Guardrails scan tool results ────────────────────────────────────────────

def _rule(action):
    return {
        "id": 1,
        "name": "Account numbers",
        "guardrail_type": "content_filter",
        "action": action,
        "config": {"type": "regex", "pattern": r"ACC-\d{4}"},
    }


@pytest.fixture
def no_detection_log(monkeypatch):
    async def _noop(**_kwargs):
        return None

    monkeypatch.setattr(proxy_service, "_log_guardrail_detection", _noop)


async def test_tool_result_is_masked(no_detection_log):
    messages = [
        {"role": "user", "content": "look it up"},
        {"role": "assistant", "content": None, "tool_calls": TOOL_CALLS},
        {"role": "tool", "tool_call_id": "call_1", "content": "Account ACC-4471 is 64 days past due"},
    ]
    out = await proxy_service.run_guardrails(1, messages, 1, config=([_rule("mask")], {}))
    assert "ACC-4471" not in out[2]["content"]
    assert out[2]["tool_call_id"] == "call_1"
    # The assistant tool-call turn passes through untouched.
    assert out[1] == messages[1]


async def test_tool_result_can_be_blocked(no_detection_log):
    messages = [{"role": "tool", "tool_call_id": "call_1", "content": "Account ACC-4471"}]
    with pytest.raises(HTTPException) as exc:
        await proxy_service.run_guardrails(1, messages, 1, config=([_rule("block")], {}))
    assert exc.value.status_code == 400


# ─── Logged response text ────────────────────────────────────────────────────

def test_response_text_is_the_content():
    assert _response_text({"role": "assistant", "content": "hello"}) == "hello"


def test_response_text_of_a_tool_call_is_the_tool_calls():
    text = _response_text({"role": "assistant", "content": None, "tool_calls": TOOL_CALLS})
    assert json.loads(text) == TOOL_CALLS


def test_response_text_of_content_parts_is_json():
    parts = [{"type": "text", "text": "hi"}]
    assert json.loads(_response_text({"role": "assistant", "content": parts})) == parts


def test_response_text_of_an_empty_message_is_none():
    assert _response_text({"role": "assistant", "content": None}) is None
    assert _response_text(None) is None
