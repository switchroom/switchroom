from __future__ import annotations

import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PROVIDER = ROOT / "plugins" / "web" / "perplexity" / "provider.py"


def load_provider():
    httpx = types.ModuleType("httpx")
    setattr(httpx, "TimeoutException", type("TimeoutException", (Exception,), {}))
    setattr(httpx, "HTTPError", type("HTTPError", (Exception,), {}))
    setattr(
        httpx,
        "post",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("unexpected network call")
        ),
    )
    agent = types.ModuleType("agent")
    web_search_provider = types.ModuleType("agent.web_search_provider")
    setattr(web_search_provider, "WebSearchProvider", type("WebSearchProvider", (), {}))
    setattr(web_search_provider, "get_provider_env", lambda _name: "")
    setattr(agent, "web_search_provider", web_search_provider)
    spec = importlib.util.spec_from_file_location("public_perplexity_provider", PROVIDER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    with patch.dict(
        sys.modules,
        {
            "httpx": httpx,
            "agent": agent,
            "agent.web_search_provider": web_search_provider,
            spec.name: module,
        },
    ):
        spec.loader.exec_module(module)
    return module


class PerplexityProviderTests(unittest.TestCase):
    def test_public_source_contract_externalizes_provider_disabled_by_default(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        workflow = (ROOT / ".github" / "workflows" / "fleet-image.yml").read_text(
            encoding="utf-8"
        )
        metadata = (PROVIDER.parent / "plugin.yaml").read_text(encoding="utf-8")
        contract = json.loads((ROOT / "contracts" / "plugins.json").read_text())
        matches = [
            item
            for item in contract["components"]
            if item["id"] == "perplexity-web-provider"
        ]

        self.assertNotIn("COPY plugins/web/perplexity/", dockerfile)
        self.assertIn("RUN test ! -e /opt/hermes/plugins/web/perplexity", dockerfile)
        self.assertIn(
            'assert not pathlib.Path("/opt/hermes/plugins/web/perplexity").exists()',
            workflow,
        )
        self.assertEqual(matches, [
            {
                "id": "perplexity-web-provider",
                "target": "standalone_public_plugin",
                "default_enabled": False,
                "default_role": "default",
                "conditions": [
                    "generic_configuration",
                    "search_only",
                    "independent_tests",
                    "license_review",
                    "no_deployment_identity",
                ],
            }
        ])
        web = [d for d in contract["public_base"]["default_set"] if "perplexity-web-provider" in d["covers"]]
        self.assertEqual([d["id"] for d in web], ["web-search"])
        # Paid only when the operator supplied the key; otherwise the default backend.
        self.assertEqual(web[0]["billing"], "operator_supplied_key")
        self.assertEqual(web[0]["degrade"]["behaviour"], "default_web_backend_and_report")
        self.assertEqual(web[0]["status"], "planned")
        self.assertIn("author: Hermes Fleet Contributors", metadata)

    def test_search_only_contract_is_generic(self):
        provider = load_provider().PerplexityWebSearchProvider()
        self.assertTrue(provider.supports_search())
        self.assertFalse(provider.supports_extract())
        schema = provider.get_setup_schema()
        self.assertEqual(schema["env_vars"], [
            {
                "key": "PERPLEXITY_API_KEY",
                "prompt": "Perplexity API key",
                "url": "https://www.perplexity.ai/settings/api",
            }
        ])
        result = provider.extract(["https://example.com"])[0]
        self.assertIn("search-only", result["error"])

    def test_search_caps_limit_and_maps_results(self):
        module = load_provider()
        response = SimpleNamespace(
            status_code=200,
            json=lambda: {"results": [{"title": "A", "url": "https://example.com", "snippet": "B"}]},
        )
        with patch.object(module, "get_provider_env", return_value="test-key"), patch.object(
            module.httpx, "post", return_value=response
        ) as post:
            result = module.PerplexityWebSearchProvider().search("  query  ", 999)
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["web"][0]["description"], "B")
        self.assertEqual(post.call_args.kwargs["json"], {"query": "query", "max_results": 20})
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer test-key")

    def test_missing_key_fails_without_network(self):
        module = load_provider()
        with patch.object(module, "get_provider_env", return_value=""), patch.object(
            module.httpx, "post"
        ) as post:
            result = module.PerplexityWebSearchProvider().search("query")
        self.assertFalse(result["success"])
        self.assertIn("not set", result["error"])
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
