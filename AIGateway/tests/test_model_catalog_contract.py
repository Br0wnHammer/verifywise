import os
import sys
from unittest.mock import MagicMock

# Add src to path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import routers.tenant_chat as tenant_chat

# Fields the Models page (catalog, cost calculator, comparison) reads from
# GET /api/ai-gateway/models/catalog — see ModelInfo in
# Clients/src/presentation/pages/AIGateway/Models/index.tsx.
MODEL_INFO_FIELDS = {
    "id",
    "provider",
    "mode",
    "max_input_tokens",
    "max_output_tokens",
    "input_cost_per_million",
    "output_cost_per_million",
    "supports_vision",
    "supports_function_calling",
    "supports_pdf_input",
    "supports_prompt_caching",
    "supports_response_schema",
    "supports_system_messages",
    "supports_tool_choice",
    "supports_parallel_function_calling",
}


# Regression: the Express-proxied catalog returned {model, input_cost_per_token,
# ...} with no id/mode/per-million prices, so the cost calculator (which keeps
# mode == "chat" with a price) was always empty and the catalog showed no names.
async def test_proxied_catalog_matches_models_page_contract(monkeypatch):
    monkeypatch.setattr(tenant_chat, "verify_internal_key", lambda _request: None)

    response = await tenant_chat.get_model_catalog(MagicMock())
    models = response["data"]["models"]

    assert response["data"]["total"] == len(models) > 0
    assert all(MODEL_INFO_FIELDS <= set(m) for m in models)

    priced_chat = [
        m
        for m in models
        if m["mode"] == "chat"
        and (m["input_cost_per_million"] > 0 or m["output_cost_per_million"] > 0)
    ]
    assert priced_chat, "the cost calculator needs priced chat models"
