"""
SSRF policy for user-entered model endpoints (self-hosted judges and scorers, custom_api
models). The policy lives in EvaluationModule (deepeval_engine.safe_outbound_url), a copy
of AIGateway/src/utils/safe_outbound_url.py; this module re-exports it.
"""

from utils.gateway_litellm_client import DEFAULT_GATEWAY_URL  # noqa: F401  (puts deepeval_engine on the path)
from deepeval_engine.safe_outbound_url import (  # noqa: E402,F401
    UnsafeOutboundUrlError,
    assert_safe_outbound_url,
)
# Clients for those endpoints: no redirects, so a checked host can't bounce the request
from deepeval_engine.endpoint_client import openai_compatible_client  # noqa: E402,F401
