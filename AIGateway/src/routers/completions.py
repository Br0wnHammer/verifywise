import logging
import re

import litellm
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from services.cost_service import estimate_prompt_cost
from services.llm_service import (
    chat_completion,
    embedding,
    stream_chat_completion,
)

router = APIRouter()
logger = logging.getLogger(__name__)

ERROR_MESSAGE_LIMIT = 500

# Key-shaped tokens and key query parameters a provider error may echo (a Gemini request
# URL carries ?key=...)
_SECRET_PATTERNS = [
    re.compile(r"(?i)([?&](?:key|api_key|api-key)=)[^&\s\"']+"),
    re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"),
    re.compile(r"\bxai-[A-Za-z0-9]{8,}"),
]


def _redact(text: str, api_key: str) -> str:
    if api_key:
        text = text.replace(api_key, "***")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(lambda m: (m.group(1) if m.groups() else "") + "***", text)
    return text


def _provider_error(exc: Exception, api_key: str) -> JSONResponse:
    """
    A failed provider call as a typed error: LiteLLM's exception class (AuthenticationError,
    NotFoundError, RateLimitError, ...) and the provider's status code.

    The HTTP status stays 502: callers forward it, and a provider's 401 must not read as
    the caller's own session expiring. Only LiteLLM's exceptions pass their message on,
    redacted; anything else gets a generic one.
    """
    status = getattr(exc, "status_code", None)
    logger.warning("Provider call failed: %s (%s)", type(exc).__name__, status)
    # LiteLLM's exceptions don't share one base class (most derive from the openai package's)
    if type(exc).__module__ == litellm.exceptions.__name__:
        message = _redact(str(exc), api_key)[:ERROR_MESSAGE_LIMIT]
    else:
        message = "The provider call failed"
    return JSONResponse(
        status_code=502,
        content={
            "error": {
                "type": type(exc).__name__,
                "status_code": status if isinstance(status, int) else None,
                "message": message,
            }
        },
    )


class CompletionRequest(BaseModel):
    model: str
    messages: list[dict]
    stream: bool = False
    temperature: float | None = None
    max_tokens: int | None = None
    tools: list | None = None
    tool_choice: str | dict | None = None
    top_p: float | None = None
    num_retries: int = 0
    fallback_models: list[str] | None = None
    extra_params: dict | None = None


class EmbeddingRequest(BaseModel):
    model: str
    input: list[str]


class CostEstimateRequest(BaseModel):
    model: str
    messages: list[dict]
    max_tokens: int = 4096


def _get_provider_key(request: Request) -> str:
    """Extract provider API key from header (not body)."""
    key = request.headers.get("x-provider-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Missing x-provider-key header")
    return key


@router.post("/v1/chat/completions")
async def chat_completions(request: Request, body: CompletionRequest):
    api_key = _get_provider_key(request)

    kwargs = {}
    if body.temperature is not None:
        kwargs["temperature"] = body.temperature
    if body.max_tokens is not None:
        kwargs["max_tokens"] = body.max_tokens
    if body.tools is not None:
        kwargs["tools"] = body.tools
    if body.tool_choice is not None:
        kwargs["tool_choice"] = body.tool_choice
    if body.top_p is not None:
        kwargs["top_p"] = body.top_p
    if body.extra_params:
        kwargs.update(body.extra_params)

    if body.stream:
        return StreamingResponse(
            stream_chat_completion(
                model=body.model,
                messages=body.messages,
                api_key=api_key,
                **kwargs,
            ),
            media_type="text/event-stream",
        )

    try:
        return await chat_completion(
            model=body.model,
            messages=body.messages,
            api_key=api_key,
            num_retries=body.num_retries,
            fallback_models=body.fallback_models,
            **kwargs,
        )
    except Exception as exc:
        return _provider_error(exc, api_key)


@router.post("/v1/embeddings")
async def embeddings(request: Request, body: EmbeddingRequest):
    api_key = _get_provider_key(request)

    result = await embedding(
        model=body.model,
        input_text=body.input,
        api_key=api_key,
    )
    return result


@router.post("/v1/cost-estimate")
async def cost_estimate(request: Request, body: CostEstimateRequest):
    """Pre-request cost estimation for budget enforcement."""

    estimated_cost = estimate_prompt_cost(
        model=body.model,
        messages=body.messages,
        max_tokens=body.max_tokens,
    )
    return {"estimated_max_cost_usd": estimated_cost}
