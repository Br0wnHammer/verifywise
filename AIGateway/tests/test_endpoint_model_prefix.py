import sys
import os

# Add src to path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from utils.endpoint_model import normalize_endpoint_model


# Regression: the endpoint form prefixed every model with "<provider>/", but
# LiteLLM already lists most Gemini, xAI, Mistral and OpenRouter models with
# that prefix. Endpoints were saved as "gemini/gemini/gemini-2.5-flash", the
# provider rejected the name and every request failed with a 500.
def test_doubled_prefix_is_collapsed():
    assert normalize_endpoint_model("gemini", "gemini/gemini/gemini-2.5-flash") == "gemini/gemini-2.5-flash"


def test_repeated_prefix_is_collapsed_to_one():
    assert normalize_endpoint_model("xai", "xai/xai/xai/grok-4") == "xai/grok-4"


def test_single_prefix_is_kept():
    assert normalize_endpoint_model("gemini", "gemini/gemini-flash-latest") == "gemini/gemini-flash-latest"
    assert normalize_endpoint_model("openai", "openai/gpt-4o-mini") == "openai/gpt-4o-mini"


def test_routed_model_names_are_kept():
    # OpenRouter models name the upstream provider after the openrouter prefix
    assert normalize_endpoint_model("openrouter", "openrouter/openai/gpt-4o") == "openrouter/openai/gpt-4o"


def test_openrouter_own_models_are_kept():
    # OpenRouter's own models have the vendor "openrouter" ("openrouter/auto"),
    # so LiteLLM names them "openrouter/openrouter/auto"
    for name in ("auto", "free", "bodybuilder"):
        model = f"openrouter/openrouter/{name}"
        assert normalize_endpoint_model("openrouter", model) == model


def test_openrouter_own_models_saved_with_extra_prefix_are_repaired():
    # The old form added "openrouter/" in front of LiteLLM's "openrouter/openrouter/auto"
    assert normalize_endpoint_model("openrouter", "openrouter/openrouter/openrouter/auto") == "openrouter/openrouter/auto"
    assert normalize_endpoint_model("openrouter", "openrouter/openrouter/openai/gpt-4o") == "openrouter/openai/gpt-4o"


def test_real_model_names_that_repeat_the_prefix_are_kept():
    # LiteLLM lists some Perplexity models this way; they are valid names
    assert normalize_endpoint_model("perplexity", "perplexity/perplexity/sonar") == "perplexity/perplexity/sonar"


def test_model_without_prefix_is_kept():
    assert normalize_endpoint_model("openai", "gpt-4o") == "gpt-4o"


def test_missing_values_pass_through():
    assert normalize_endpoint_model(None, "gemini/gemini/x") == "gemini/gemini/x"
    assert normalize_endpoint_model("gemini", None) is None
    assert normalize_endpoint_model("", "a/a/b") == "a/a/b"


# ─── Endpoint routes store the repaired name ─────────────────────────────────

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import routers.endpoints as endpoints_router  # noqa: E402


def _client(monkeypatch, existing=None):
    saved = {}

    async def fake_create(org_id, data):
        saved["create"] = dict(data)
        return {"id": 1, "display_name": data.get("display_name"), **data}

    async def fake_update(org_id, endpoint_id, data):
        saved["update"] = dict(data)
        return {"id": endpoint_id, "display_name": "x", **data}

    async def fake_get(org_id, endpoint_id, role_id=None):
        return existing

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(endpoints_router.endpoints_crud, "create_endpoint", fake_create)
    monkeypatch.setattr(endpoints_router.endpoints_crud, "update_endpoint", fake_update)
    monkeypatch.setattr(endpoints_router.endpoints_crud, "get_endpoint_by_id", fake_get)
    monkeypatch.setattr(endpoints_router, "notify_config_change", noop)
    monkeypatch.setattr(endpoints_router, "record_endpoint_change", noop)

    app = FastAPI()

    @app.middleware("http")
    async def admin_context(request: Request, call_next):
        request.state.organization_id = 1
        request.state.user_id = 1
        request.state.role = "Admin"
        return await call_next(request)

    app.include_router(endpoints_router.router)
    return TestClient(app), saved


def test_create_route_stores_single_prefix(monkeypatch):
    client, saved = _client(monkeypatch)
    res = client.post("/endpoints", json={
        "slug": "faq", "display_name": "FAQ", "provider": "gemini",
        "model": "gemini/gemini/gemini-2.5-flash", "api_key_id": 1,
    })
    assert res.status_code == 200, res.text
    assert saved["create"]["model"] == "gemini/gemini-2.5-flash"


def test_update_route_uses_stored_provider_when_body_has_none(monkeypatch):
    client, saved = _client(monkeypatch, existing={"id": 7, "provider": "xai", "model": "xai/grok-4"})
    res = client.patch("/endpoints/7", json={"model": "xai/xai/grok-4-fast"})
    assert res.status_code == 200, res.text
    assert saved["update"]["model"] == "xai/grok-4-fast"


def test_update_route_without_model_leaves_it_out(monkeypatch):
    client, saved = _client(monkeypatch, existing={"id": 7, "provider": "xai", "model": "xai/grok-4"})
    res = client.patch("/endpoints/7", json={"display_name": "Renamed"})
    assert res.status_code == 200, res.text
    assert "model" not in saved["update"]


def test_providers_without_stored_keys_are_left_alone():
    # Same provider set as migration a0017, so the API and the repaired data agree
    assert normalize_endpoint_model("perplexity", "perplexity/perplexity/new-model") == "perplexity/perplexity/new-model"


def test_non_string_model_is_rejected_on_create(monkeypatch):
    client, saved = _client(monkeypatch)
    res = client.post("/endpoints", json={
        "slug": "faq", "display_name": "FAQ", "provider": "openai", "model": ["gpt-4o"],
    })
    assert res.status_code == 400
    assert "create" not in saved


def test_non_string_model_is_rejected_on_update(monkeypatch):
    client, saved = _client(monkeypatch, existing={"id": 7, "provider": "openai", "model": "gpt-4o"})
    res = client.patch("/endpoints/7", json={"model": 5})
    assert res.status_code == 400
    assert "update" not in saved
