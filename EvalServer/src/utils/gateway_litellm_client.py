"""
Call AI Gateway internal LiteLLM completion API (same path Express uses).

The client lives in EvaluationModule (deepeval_engine.gateway_litellm_client), which
EvalServer already imports; this module re-exports it so both use one implementation.
"""

import sys
from pathlib import Path

# Docker copies deepeval_engine next to the app; a checkout needs EvaluationModule/src on the
# path, which run_evaluation adds too, but this module may be imported first
_EVALUATION_MODULE_SRC = (Path(__file__).resolve().parents[3] / "EvaluationModule" / "src")
if _EVALUATION_MODULE_SRC.is_dir() and str(_EVALUATION_MODULE_SRC) not in sys.path:
    sys.path.insert(0, str(_EVALUATION_MODULE_SRC))

from deepeval_engine.gateway_litellm_client import (  # noqa: E402,F401
    DEFAULT_GATEWAY_URL,
    GatewayCompletion,
    GatewayProviderError,
    _extract_assistant_text,
    gateway_chat_completion_async,
    gateway_chat_completion_sync,
    gateway_completion_async,
    gateway_completion_sync,
    gateway_mode_enabled,
    to_litellm_model,
)
