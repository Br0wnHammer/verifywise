# verifywise-agent-control

Connect a Python agent to VerifyWise Agent Control. Every tool call the agent makes is checked by the VerifyWise AI Gateway before it runs, and its result is recorded after. Guardrail rules, approval rules and the agent key's allowed/blocked tool lists all apply, and each call shows up in AI Gateway → Agent Control → Activity.

The package behaves the same way as the Claude Code shell hook (`scripts/vw-tool-hook.sh`). It reads the same environment variables and uses the same defaults.

## Install

The package is installed from the VerifyWise GitHub repository. It is not on PyPI.

```bash
# Core only (plain Python, @governed decorator)
pip install "verifywise-agent-control @ git+https://github.com/verifywise-ai/verifywise.git@sdk-py-v0.1.0#subdirectory=sdks/python/verifywise-agent-control"

# With the LangChain adapter
pip install "verifywise-agent-control[langchain] @ git+https://github.com/verifywise-ai/verifywise.git@sdk-py-v0.1.0#subdirectory=sdks/python/verifywise-agent-control"
```

Requires Python 3.10 or later. The core depends only on `httpx`.

## Configuration

Create an agent key in AI Gateway → Agent Control → Agent keys (the value starts with `sk-mcp-`), then set:

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `VW_GATEWAY_URL` | yes | | AI Gateway base URL, e.g. `http://localhost:8100` |
| `VW_AGENT_KEY` | yes | | Agent key, `sk-mcp-...` |
| `VW_FAIL_MODE` | no | `open` | `open` runs the tool when the gateway can't decide; `closed` refuses it |
| `VW_TIMEOUT` | no | `3` | Seconds per gateway request |
| `VW_APPROVAL_WAIT` | no | `120` | Max seconds to wait for a human approval |
| `VW_APPROVAL_FAIL_MODE` | no | `closed` | On approval timeout or expiry: `closed` refuses, `open` runs |

Every setting can also be passed in code, and code wins over the environment:

```python
from verifywise_agent_control import AgentControlClient

client = AgentControlClient(gateway_url="http://localhost:8100", agent_key="sk-mcp-...", fail_mode="closed")
```

If the gateway URL or key is missing, the SDK logs a warning and applies `VW_FAIL_MODE`, like the shell hook.

## Behaviour

| Gateway answer | What the SDK does |
|---|---|
| `allow` | Runs the tool, then records its output (truncated to 10 KB) |
| `allow` in monitor mode | Runs the tool and logs one `WARNING` describing what would have happened |
| `deny` | Doesn't run the tool. The model gets `Blocked by VerifyWise policy: <reason>` and the agent continues |
| `approval_required` | Polls every 2 s for up to `VW_APPROVAL_WAIT`. Approved → runs. Denied → refusal. Expired or timed out → `VW_APPROVAL_FAIL_MODE` |
| `rate_limited` | Applies `VW_FAIL_MODE` |
| Unreachable, non-200, unreadable reply | Applies `VW_FAIL_MODE` (default: run the tool) |

To stop the agent instead of handing the model a refusal, pass `on_deny="raise"`; a refused call then raises `VerifyWiseDenied`.

When the tool itself raises, the error text is recorded and the original exception is re-raised unchanged. Otherwise the SDK never raises into your agent. Result recording and logging failures are swallowed.

All log lines use the logger `verifywise_agent_control`.

## Runs

Tool calls are grouped into runs. The run id is chosen in this order:

1. An explicit `with vw_session("my-run-id"):` block
2. The framework's thread id, when there is one (LangGraph `thread_id`)
3. A new id per agent invocation (LangChain), or per client (`@governed`)

If your model calls also go through the VerifyWise AI Gateway, send the same id as the `x-vw-agent-run-id` header on them so model calls and tool calls appear in one run:

```python
from verifywise_agent_control import vw_session

with vw_session() as run_id:
    # pass run_id as the x-vw-agent-run-id header on your model client
    agent.invoke(...)
```

## LangChain

Uses the LangChain v1 agent middleware (`create_agent`), so every tool the agent calls is governed, including tools added by other middleware.

```python
from langchain.agents import create_agent
from verifywise_agent_control.langchain import VerifyWiseMiddleware

agent = create_agent(
    model="openai:gpt-4.1",
    tools=[search, send_email],
    middleware=[VerifyWiseMiddleware()],
)

agent.invoke({"messages": [{"role": "user", "content": "Email the weekly report"}]})
```

A refused call becomes a `ToolMessage` with `status="error"` and the refusal text, so the model can explain or try something else. `ainvoke` and `astream` work the same way. Pass `client=` / `async_client=` to use explicit settings.

## CrewAI

_Coming in the next release._

## Microsoft Agent Framework

_Coming in the next release._

## Plain Python

For custom agents, wrap the functions your agent calls:

```python
from verifywise_agent_control import governed, govern_tool

@governed
def delete_customer(customer_id: str) -> str:
    ...

@governed(name="crm.lookup")
async def lookup(email: str) -> dict:
    ...

safe_tool = govern_tool(existing_function, name="existing_tool")
```

A refused call returns the refusal text instead of running the function. Async functions are supported; pass an `AsyncAgentControlClient` as `client=` for them, or let the SDK build one from the environment.

## Tested versions

| Package | Version |
|---|---|
| Python | 3.10, 3.12 |
| httpx | 0.28.1 |
| langchain | 1.4.6 |
| langchain-core | 1.6.10 |

## Development

```bash
cd sdks/python/verifywise-agent-control
python -m venv .venv
.venv/bin/pip install -e ".[all,dev]"
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/pytest
```

The tests use `respx` for the gateway and a scripted fake chat model for LangChain, so they need no network access and no LLM.
