"""Public sidecar package contract: new GHCR names, no private bake coupling."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_SOURCE_URL = "https://github.com/switchroom/switchroom"
CONTRACT = ROOT / "sidecars/packages.json"
IMAGE_REF = ROOT / "scripts/sidecar_image_ref.py"
SCOPE = ROOT / "scripts/fleet-image-change-scope.py"
FLEET_WORKFLOW = ROOT / ".github/workflows/fleet-image.yml"

PUBLIC_PACKAGES = {
    "rest-lock-proxy": "ghcr.io/switchroom/rest-lock-proxy",
    "tcp-proxy": "ghcr.io/switchroom/tcp-proxy",
    "browser-broker": "ghcr.io/switchroom/browser-broker",
    "kokoro": "ghcr.io/switchroom/kokoro",
}

RETIRED_PRIVATE_PACKAGES = (
    "ghcr.io/mekenthompson/hermes-rest-lock-proxy",
    "ghcr.io/mekenthompson/hermes-tcp-proxy",
    "ghcr.io/mekenthompson/hermes-browser-broker",
    "ghcr.io/mekenthompson/hermes-kokoro",
    "ghcr.io/mekenthompson/hermes-camofox",
)

DIGEST = "0123456789abcdef" * 4


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@contextmanager
def environ(**overrides: str | None):
    previous = {key: os.environ.get(key) for key in overrides}
    try:
        for key, value in overrides.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def stub_jwt() -> None:
    jwt_mod = types.ModuleType("jwt")

    class PyJWKClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

    jwt_mod.PyJWKClient = PyJWKClient  # type: ignore[attr-defined]
    sys.modules["jwt"] = jwt_mod


class SidecarContractTests(unittest.TestCase):
    def test_sidecar_contract_declares_prefixed_public_packages(self) -> None:
        payload = json.loads(CONTRACT.read_text(encoding="utf-8"))
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(
            payload["source_repository"],
            "https://github.com/switchroom/switchroom",
        )
        packages = payload["packages"]
        for key, image in PUBLIC_PACKAGES.items():
            with self.subTest(key=key):
                self.assertEqual(packages[key]["image"], image)
                self.assertEqual(packages[key]["visibility"], "public")
                self.assertTrue(packages[key]["require_digest_pin"])
                self.assertEqual(packages[key]["context"], f"sidecars/{key}")
        self.assertEqual(packages["rest-lock-proxy"]["status"], "publishing")
        self.assertEqual(packages["tcp-proxy"]["status"], "publishing")
        self.assertEqual(packages["browser-broker"]["status"], "publishing")
        self.assertEqual(packages["kokoro"]["status"], "publishing")
        self.assertFalse((ROOT / "services").exists())

    def test_sidecar_contract_does_not_publish_unprefixed_private_names(self) -> None:
        text = CONTRACT.read_text(encoding="utf-8")
        for name in RETIRED_PRIVATE_PACKAGES:
            with self.subTest(name=name):
                self.assertNotIn(name, text)
        self.assertNotIn("hermes-fleet-private", text)
        self.assertNotIn("private_house", text.lower())

    def test_publishing_sidecars_have_dockerfiles_and_public_source_label(self) -> None:
        for name in ("rest-lock-proxy", "tcp-proxy", "browser-broker", "kokoro"):
            dockerfile = ROOT / "sidecars" / name / "Dockerfile"
            with self.subTest(name=name):
                text = dockerfile.read_text(encoding="utf-8")
                self.assertIn("org.opencontainers.image.source=\"https://github.com/switchroom/switchroom\"", text)
                self.assertIn(f"org.opencontainers.image.title=\"hermes-fleet-{name}\"", text)
                self.assertNotIn("hermes-fleet-private", text)
                self.assertNotIn("KEN-", text)


class BrowserBrokerPublicTests(unittest.TestCase):
    def test_browser_broker_is_publishing_with_public_dockerfile(self) -> None:
        payload = json.loads(CONTRACT.read_text(encoding="utf-8"))
        self.assertEqual(payload["packages"]["browser-broker"]["status"], "publishing")
        dockerfile = ROOT / "sidecars/browser-broker/Dockerfile"
        self.assertTrue(dockerfile.is_file(), dockerfile)
        text = dockerfile.read_text(encoding="utf-8")
        self.assertIn(
            'org.opencontainers.image.source="https://github.com/switchroom/switchroom"',
            text,
        )
        self.assertIn('org.opencontainers.image.title="hermes-fleet-browser-broker"', text)
        self.assertNotIn("hermes-fleet-private", text)
        self.assertNotIn("KEN-", text)

    def test_browser_broker_source_has_no_house_topology(self) -> None:
        root = ROOT / "sidecars/browser-broker"
        self.assertTrue(root.is_dir(), root)
        prohibited = (
            "switchroom",
            "car" + "rie",
            "over" + "lord",
            "klank" + "er",
            "gr" + "unt",
            "cl" + "erk",
            "gym" + "bro",
            "mar" + "ko",
            "law" + "gpt",
            "ag" + "gie",
            "KEN-",
        )
        for path in root.rglob("*"):
            # CI writes __pycache__ beside sources; bytecode embeds the checkout path.
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            # The OCI source label names the public product repository; nothing else may.
            text = path.read_text(encoding="utf-8", errors="ignore").replace(PUBLIC_SOURCE_URL, "")
            lowered = text.lower()
            for ident in prohibited:
                with self.subTest(path=str(path.relative_to(ROOT)), ident=ident):
                    self.assertNotIn(ident.lower() if ident != "KEN-" else ident, lowered if ident != "KEN-" else text)

    def test_browser_broker_public_base_comes_from_env(self) -> None:
        previous_base = os.environ.get("PUBLIC_BASE")
        previous_origin = os.environ.get("PUBLIC_ORIGIN")
        os.environ["PUBLIC_BASE"] = "https://browser.example.test"
        os.environ["PUBLIC_ORIGIN"] = "https://browser.example.test"
        try:
            config = load(
                ROOT / "sidecars/browser-broker/public_config.py",
                "public_config_public_base",
            )
            self.assertEqual(config.canonical_public_url(), "https://browser.example.test")
            self.assertNotIn("switchroom", config.canonical_public_url().lower())
        finally:
            if previous_base is None:
                os.environ.pop("PUBLIC_BASE", None)
            else:
                os.environ["PUBLIC_BASE"] = previous_base
            if previous_origin is None:
                os.environ.pop("PUBLIC_ORIGIN", None)
            else:
                os.environ["PUBLIC_ORIGIN"] = previous_origin

    def test_canonical_public_url_requires_env(self) -> None:
        previous_base = os.environ.pop("PUBLIC_BASE", None)
        previous_origin = os.environ.pop("PUBLIC_ORIGIN", None)
        try:
            config = load(ROOT / "sidecars/browser-broker/public_config.py", "public_config_missing_url")
            with self.assertRaises(config.PublicUrlError):
                config.canonical_public_url()
        finally:
            if previous_base is None:
                os.environ.pop("PUBLIC_BASE", None)
            else:
                os.environ["PUBLIC_BASE"] = previous_base
            if previous_origin is None:
                os.environ.pop("PUBLIC_ORIGIN", None)
            else:
                os.environ["PUBLIC_ORIGIN"] = previous_origin

    def test_canonical_public_url_rejects_missing_public_origin(self) -> None:
        previous_base = os.environ.get("PUBLIC_BASE")
        previous_origin = os.environ.pop("PUBLIC_ORIGIN", None)
        os.environ["PUBLIC_BASE"] = "https://browser.example.test"
        try:
            config = load(
                ROOT / "sidecars/browser-broker/public_config.py",
                "public_config_missing_origin",
            )
            with self.assertRaises(config.PublicUrlError):
                config.canonical_public_url()
        finally:
            if previous_base is None:
                os.environ.pop("PUBLIC_BASE", None)
            else:
                os.environ["PUBLIC_BASE"] = previous_base
            if previous_origin is None:
                os.environ.pop("PUBLIC_ORIGIN", None)
            else:
                os.environ["PUBLIC_ORIGIN"] = previous_origin

    def test_canonical_public_url_rejects_missing_public_base(self) -> None:
        previous_origin = os.environ.get("PUBLIC_ORIGIN")
        previous_base = os.environ.pop("PUBLIC_BASE", None)
        os.environ["PUBLIC_ORIGIN"] = "https://browser.example.test"
        try:
            config = load(
                ROOT / "sidecars/browser-broker/public_config.py",
                "public_config_missing_base",
            )
            with self.assertRaises(config.PublicUrlError):
                config.canonical_public_url()
        finally:
            if previous_base is None:
                os.environ.pop("PUBLIC_BASE", None)
            else:
                os.environ["PUBLIC_BASE"] = previous_base
            if previous_origin is None:
                os.environ.pop("PUBLIC_ORIGIN", None)
            else:
                os.environ["PUBLIC_ORIGIN"] = previous_origin

    def test_canonical_public_url_rejects_mismatch(self) -> None:
        previous_base = os.environ.get("PUBLIC_BASE")
        previous_origin = os.environ.get("PUBLIC_ORIGIN")
        os.environ["PUBLIC_BASE"] = "https://browser.example.test"
        os.environ["PUBLIC_ORIGIN"] = "https://other.example.test"
        try:
            config = load(ROOT / "sidecars/browser-broker/public_config.py", "public_config_mismatch")
            with self.assertRaises(config.PublicUrlError):
                config.canonical_public_url()
        finally:
            if previous_base is None:
                os.environ.pop("PUBLIC_BASE", None)
            else:
                os.environ["PUBLIC_BASE"] = previous_base
            if previous_origin is None:
                os.environ.pop("PUBLIC_ORIGIN", None)
            else:
                os.environ["PUBLIC_ORIGIN"] = previous_origin

    def test_brand_defaults_to_browser(self) -> None:
        previous = os.environ.pop("BRAND", None)
        try:
            config = load(ROOT / "sidecars/browser-broker/public_config.py", "public_config_brand_default")
            self.assertEqual(config.brand(), "Browser")
        finally:
            if previous is None:
                os.environ.pop("BRAND", None)
            else:
                os.environ["BRAND"] = previous

    def test_brand_comes_from_env(self) -> None:
        previous = os.environ.get("BRAND")
        os.environ["BRAND"] = "Example"
        try:
            config = load(ROOT / "sidecars/browser-broker/public_config.py", "public_config_brand_env")
            self.assertEqual(config.brand(), "Example")
        finally:
            if previous is None:
                os.environ.pop("BRAND", None)
            else:
                os.environ["BRAND"] = previous

    def test_local_tz_falls_back_to_tz_env_never_utc_default(self) -> None:
        saved = {k: os.environ.pop(k, None) for k in ("LOCAL_TZ", "TZ")}
        try:
            config = load(ROOT / "sidecars/browser-broker/public_config.py", "public_config_tz_default")
            self.assertEqual(config.local_tz(), "")
            os.environ["TZ"] = "Australia/Melbourne"
            self.assertEqual(config.local_tz(), "Australia/Melbourne")
            os.environ["LOCAL_TZ"] = "Australia/Sydney"
            self.assertEqual(config.local_tz(), "Australia/Sydney")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_expiry_renders_in_local_zone_with_abbreviation(self) -> None:
        saved = os.environ.get("LOCAL_TZ")
        os.environ["LOCAL_TZ"] = "Australia/Melbourne"
        try:
            ux = load(ROOT / "sidecars/browser-broker/ux.py", "ux_tz_render")
            # 2026-11-22 03:05 UTC == 2:05pm AEDT
            self.assertEqual(ux._local_time(1795316700.0), "2:05pm AEDT")
        finally:
            if saved is None:
                os.environ.pop("LOCAL_TZ", None)
            else:
                os.environ["LOCAL_TZ"] = saved

    def test_viewer_page_uses_brand_env(self) -> None:
        previous = os.environ.get("BRAND")
        os.environ["BRAND"] = "Example"
        try:
            ux = load(ROOT / "sidecars/browser-broker/ux.py", "ux_brand_env")
            page = ux.viewer_page("11111111-1111-4111-8111-111111111111", agent_id="example")
            self.assertIn(">Example</div>", page)
            self.assertNotIn(">Browser</div>", page)
        finally:
            if previous is None:
                os.environ.pop("BRAND", None)
            else:
                os.environ["BRAND"] = previous

    def test_minted_url_uses_canonical_public_url(self) -> None:
        previous_base = os.environ.get("PUBLIC_BASE")
        previous_origin = os.environ.get("PUBLIC_ORIGIN")
        os.environ["PUBLIC_BASE"] = "https://browser.example.test"
        os.environ["PUBLIC_ORIGIN"] = "https://browser.example.test"
        try:
            policy = load(ROOT / "sidecars/browser-broker/session_policy.py", "session_policy_mint_url")
            invocation = policy.Invocation(
                profile="example",
                platform="slack",
                user_id="1",
                chat_id="1",
                thread_id="",
                chat_type="im",
            )
            sess = policy._Session(
                "11111111-1111-4111-8111-111111111111",
                "example",
                "default",
                "principal",
                "user@example.test",
                invocation,
                "pending",
                0.0,
                1.0,
            )
            minted = policy.HandoffBroker._minted(sess)
            self.assertEqual(
                minted.url,
                "https://browser.example.test/example/11111111-1111-4111-8111-111111111111",
            )
        finally:
            if previous_base is None:
                os.environ.pop("PUBLIC_BASE", None)
            else:
                os.environ["PUBLIC_BASE"] = previous_base
            if previous_origin is None:
                os.environ.pop("PUBLIC_ORIGIN", None)
            else:
                os.environ["PUBLIC_ORIGIN"] = previous_origin

    def test_origin_startup_rejects_missing_public_origin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            state.write_text(
                json.dumps({"aud": "aud", "issuer": "https://issuer.example.test"}),
                encoding="utf-8",
            )
            stub_jwt()
            with environ(
                HANDOFF_STATE_FILE=None,
                HANDOFF_SESSION_STORE=None,
                ACCESS_STATE=str(state),
                HANDOFF_PLUGIN_PROTOCOL_VERSION="1",
                HANDOFF_BROKER_PROTOCOL_VERSION="1",
                HANDOFF_POLICY_VERSION="1",
                HANDOFF_AGENT="example",
                PUBLIC_BASE="https://browser.example.test",
                PUBLIC_ORIGIN=None,
            ):
                origin = load(ROOT / "sidecars/browser-broker/origin.py", "origin_missing_origin")
                with self.assertRaises(SystemExit) as raised:
                    origin.main()
            self.assertIn("PUBLIC_ORIGIN", str(raised.exception))

    def test_origin_startup_rejects_missing_public_base(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            state.write_text(
                json.dumps({"aud": "aud", "issuer": "https://issuer.example.test"}),
                encoding="utf-8",
            )
            stub_jwt()
            with environ(
                HANDOFF_STATE_FILE=None,
                HANDOFF_SESSION_STORE=None,
                ACCESS_STATE=str(state),
                HANDOFF_PLUGIN_PROTOCOL_VERSION="1",
                HANDOFF_BROKER_PROTOCOL_VERSION="1",
                HANDOFF_POLICY_VERSION="1",
                HANDOFF_AGENT="example",
                PUBLIC_BASE=None,
                PUBLIC_ORIGIN="https://browser.example.test",
            ):
                origin = load(ROOT / "sidecars/browser-broker/origin.py", "origin_missing_base")
                with self.assertRaises(SystemExit) as raised:
                    origin.main()
            self.assertIn("PUBLIC_BASE", str(raised.exception))

    def test_csrf_rejects_noncanonical_origin(self) -> None:
        stub_jwt()
        with environ(
            PUBLIC_BASE="https://browser.example.test",
            PUBLIC_ORIGIN="https://browser.example.test",
        ):
            origin = load(ROOT / "sidecars/browser-broker/origin.py", "origin_csrf")

            class FakeHandler:
                headers = {"Origin": "https://evil.example.test"}
                denied: tuple[int, bytes] | None = None

                def _deny(self, status: int, body: bytes) -> None:
                    self.denied = (status, body)

            for method_name in ("_uuid_mode", "_uuid_extend", "_uuid_end"):
                with self.subTest(method=method_name):
                    fake = FakeHandler()
                    method = getattr(origin.Handler, method_name)
                    if method_name == "_uuid_mode":
                        method(fake, "example", "11111111-1111-4111-8111-111111111111", True)
                    else:
                        method(fake, "example", "11111111-1111-4111-8111-111111111111")
                    self.assertEqual(fake.denied, (403, b"csrf\n"))

    def test_csrf_accepts_canonical_origin(self) -> None:
        stub_jwt()
        with environ(
            PUBLIC_BASE="https://browser.example.test",
            PUBLIC_ORIGIN="https://browser.example.test",
        ):
            origin = load(ROOT / "sidecars/browser-broker/origin.py", "origin_csrf_ok")

            class FakeHandler:
                headers = {"Origin": "https://browser.example.test"}
                denied: tuple[int, bytes] | None = None

                def _deny(self, status: int, body: bytes) -> None:
                    self.denied = (status, body)

                def _email(self) -> str:
                    raise RuntimeError("no jwt")

            fake = FakeHandler()
            origin.Handler._uuid_mode(
                fake, "example", "11111111-1111-4111-8111-111111111111", True
            )
            self.assertEqual(fake.denied, (401, b"unauthorized\n"))

    def test_browser_broker_workflow_targets_new_public_package(self) -> None:
        path = ROOT / ".github/workflows/sidecar-browser-broker.yml"
        self.assertTrue(path.is_file(), path)
        text = path.read_text(encoding="utf-8")
        self.assertIn("ghcr.io/switchroom/browser-broker", text)
        self.assertIn("github.repository == 'switchroom/switchroom'", text)
        self.assertNotIn("hermes-fleet-private", text)
        self.assertNotIn("ghcr.io/mekenthompson/hermes-browser-broker", text)
        self.assertIn("sidecars/browser-broker/**", text)
        self.assertNotIn("services/browser-broker", text)
        self.assertNotIn("secrets.", text)
        self.assertIn("github.token", text)


class SidecarImageRefTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ref = load(IMAGE_REF, "sidecar_image_ref")

    def test_accepts_digest_pin_for_allowed_public_package(self) -> None:
        value = f"ghcr.io/switchroom/rest-lock-proxy@sha256:{DIGEST}"
        self.assertEqual(self.ref.require_sidecar_image(value), value)

    def test_accepts_digest_pin_for_legacy_package_name(self) -> None:
        value = f"ghcr.io/mekenthompson/hermes-fleet-rest-lock-proxy@sha256:{DIGEST}"
        self.assertEqual(self.ref.require_sidecar_image(value), value)

    def test_rejects_mutable_tag(self) -> None:
        with self.assertRaises(ValueError):
            self.ref.require_sidecar_image(
                "ghcr.io/switchroom/rest-lock-proxy:latest"
            )

    def test_rejects_unprefixed_private_package_even_with_digest(self) -> None:
        with self.assertRaises(ValueError):
            self.ref.require_sidecar_image(
                f"ghcr.io/mekenthompson/hermes-rest-lock-proxy@sha256:{DIGEST}"
            )

    def test_rejects_agent_child_package(self) -> None:
        with self.assertRaises(ValueError):
            self.ref.require_sidecar_image(
                f"ghcr.io/switchroom/switchroom@sha256:{DIGEST}"
            )


class SidecarScopeIsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.scope = load(SCOPE, "fleet_image_change_scope")

    def test_sidecar_paths_do_not_trigger_fleet_child_bake(self) -> None:
        for path in (
            "sidecars/rest-lock-proxy/Dockerfile",
            "sidecars/tcp-proxy/entrypoint.sh",
            "sidecars/browser-broker/Dockerfile",
            "sidecars/browser-broker/public_config.py",
            "sidecars/kokoro/Dockerfile",
            "sidecars/kokoro/server.py",
            ".github/workflows/sidecar-rest-lock-proxy.yml",
            ".github/workflows/sidecar-tcp-proxy.yml",
            ".github/workflows/sidecar-browser-broker.yml",
            ".github/workflows/sidecar-kokoro.yml",
            "sidecars/packages.json",
            "scripts/sidecar_image_ref.py",
            "docs/sidecars.md",
        ):
            with self.subTest(path=path):
                run, _, matched = self.scope.decide(
                    "push", "a" * 40, "b" * 40, lambda *_: [path]
                )
                self.assertFalse(run)
                self.assertEqual(matched, [])

    def test_sidecar_workflows_target_new_public_packages_and_this_repo(self) -> None:
        mapping = {
            "rest-lock-proxy": ROOT / ".github/workflows/sidecar-rest-lock-proxy.yml",
            "tcp-proxy": ROOT / ".github/workflows/sidecar-tcp-proxy.yml",
            "browser-broker": ROOT / ".github/workflows/sidecar-browser-broker.yml",
            "kokoro": ROOT / ".github/workflows/sidecar-kokoro.yml",
        }
        for name, path in mapping.items():
            text = path.read_text(encoding="utf-8")
            with self.subTest(name=name):
                self.assertIn(f"ghcr.io/switchroom/{name}", text)
                self.assertIn("github.repository == 'switchroom/switchroom'", text)
                self.assertNotIn("hermes-fleet-private", text)
                self.assertNotIn(f"ghcr.io/mekenthompson/hermes-{name}", text)
                self.assertIn(f"sidecars/{name}/**", text)
                self.assertNotIn(f"services/{name}", text)
                self.assertNotIn("secrets.", text)
                self.assertIn("github.token", text)
                self.assertNotIn("Dockerfile\n", text.split("paths:")[1].split("jobs:")[0] if "paths:" in text else "")

    def test_sidecar_bake_paths_exclude_shared_catalog_and_tests(self) -> None:
        shared = (
            "sidecars/packages.json",
            "scripts/sidecar_image_ref.py",
            "tests/test_sidecar_packages.py",
        )
        mapping = {
            "rest-lock-proxy": ROOT / ".github/workflows/sidecar-rest-lock-proxy.yml",
            "tcp-proxy": ROOT / ".github/workflows/sidecar-tcp-proxy.yml",
            "browser-broker": ROOT / ".github/workflows/sidecar-browser-broker.yml",
            "kokoro": ROOT / ".github/workflows/sidecar-kokoro.yml",
        }
        for name, path in mapping.items():
            header = path.read_text(encoding="utf-8").split("jobs:", 1)[0]
            with self.subTest(name=name):
                for shared_path in shared:
                    self.assertNotIn(shared_path, header)
                self.assertIn(f"sidecars/{name}/**", header)
                self.assertIn(f".github/workflows/sidecar-{name}.yml", header)


class KokoroPublicTests(unittest.TestCase):
    def test_dockerfile_copies_runtime_helpers_and_uses_public_name(self) -> None:
        dockerfile = (ROOT / "sidecars/kokoro/Dockerfile").read_text(encoding="utf-8")
        self.assertIn("COPY server.py /opt/voice-sidecar/server.py", dockerfile)
        self.assertIn("COPY worker_lane.py /opt/voice-sidecar/worker_lane.py", dockerfile)
        self.assertIn("COPY text_normalize.py /opt/voice-sidecar/text_normalize.py", dockerfile)
        self.assertIn("COPY overrides.json /opt/voice-sidecar/overrides.json", dockerfile)
        self.assertIn("USER 65532:65532", dockerfile)
        self.assertIn("nvidia/cuda:", dockerfile)
        self.assertIn("Acquire::Retries", dockerfile)
        self.assertIn("until apt-get update", dockerfile)
        self.assertIn("python3 python3-pip ffmpeg ca-certificates", dockerfile)
        self.assertNotIn("hermes-kokoro", dockerfile)
        self.assertNotIn("Ken Thompson", dockerfile)
        self.assertNotIn("compose.ts", dockerfile)
        self.assertNotIn("services/kokoro", dockerfile)

    def test_public_kokoro_tree_has_no_household_or_private_strings(self) -> None:
        prohibited = (
            "car" + "rie",
            "over" + "lord",
            "klank" + "er",
            "gr" + "unt",
            "cl" + "erk",
            "gym" + "bro",
            "mar" + "ko",
            "law" + "gpt",
            "ag" + "gie",
            "switch" + "room",
            "hermes-fleet-private",
        )
        root = ROOT / "sidecars/kokoro"
        for path in sorted(root.rglob("*")):
            # CI writes __pycache__ beside sources; bytecode embeds the checkout path.
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            # The OCI source label names the public product repository; nothing else may.
            text = path.read_text(encoding="utf-8", errors="ignore").lower().replace(PUBLIC_SOURCE_URL, "")
            for needle in prohibited:
                with self.subTest(path=str(path.relative_to(ROOT)), needle=needle):
                    self.assertNotIn(needle.lower(), text)


class CamofoxSidecarRetiredTests(unittest.TestCase):
    """Camoufox runs in the Fleet image on each agent's Bot Desktop (HF-773).

    The sidecar build is gone. Published digests stay in GHCR; nothing here
    deletes or retags them.
    """

    def test_no_camofox_sidecar_source_workflow_or_package(self) -> None:
        self.assertFalse((ROOT / "sidecars/camofox").exists())
        self.assertFalse((ROOT / ".github/workflows/sidecar-camofox.yml").exists())
        packages = json.loads(CONTRACT.read_text(encoding="utf-8"))["packages"]
        self.assertNotIn("camofox", packages)

    def test_sidecar_refs_no_longer_accept_camofox(self) -> None:
        ref = load(IMAGE_REF, "sidecar_image_ref_retired")
        for repository in ("ghcr.io/switchroom/camofox", "ghcr.io/mekenthompson/hermes-fleet-camofox"):
            with self.subTest(repository=repository), self.assertRaises(ValueError):
                ref.require_sidecar_image(f"{repository}@sha256:{DIGEST}")

    def test_docs_and_example_drop_the_camofox_sidecar(self) -> None:
        docs = (ROOT / "docs/sidecars.md").read_text(encoding="utf-8")
        example = (ROOT / "examples/compose.sidecars.example.yaml").read_text(encoding="utf-8")
        self.assertNotIn("ghcr.io/switchroom/camofox", docs)
        self.assertNotIn("sidecars/camofox", docs)
        self.assertNotIn("HERMES_FLEET_CAMOFOX_IMAGE", example)
        self.assertNotIn("camofox", example.lower())


class RestLockBehaviorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.lock = load(ROOT / "sidecars/rest-lock-proxy/lock_proxy.py", "lock_proxy")

    def test_missing_lock_file_is_unlocked(self) -> None:
        missing = Path(tempfile.mkdtemp()) / "lock"
        self.assertFalse(self.lock.lock_is_active(missing))

    def test_existing_lock_file_is_locked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "lock"
            lock_file.write_text("held\n", encoding="utf-8")
            self.assertTrue(self.lock.lock_is_active(lock_file))


class TcpProxyEntrypointTests(unittest.TestCase):
    def test_entrypoint_requires_listen_port_and_target(self) -> None:
        script = ROOT / "sidecars/tcp-proxy/entrypoint.sh"
        self.assertTrue(script.is_file(), script)
        env = {**os.environ}
        env.pop("LISTEN_PORT", None)
        env.pop("TARGET", None)
        result = subprocess.run(
            ["sh", str(script)],
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
