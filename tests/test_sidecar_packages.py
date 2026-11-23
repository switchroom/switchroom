"""Public sidecar package contract: new GHCR names, no private bake coupling."""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_SOURCE_URL = "https://github.com/switchroom/switchroom"
CONTRACT = ROOT / "sidecars/packages.json"
IMAGE_REF = ROOT / "scripts/sidecar_image_ref.py"
SCOPE = ROOT / "scripts/fleet-image-change-scope.py"
FLEET_WORKFLOW = ROOT / ".github/workflows/fleet-image.yml"

PUBLIC_PACKAGES = {
    "kokoro": "ghcr.io/switchroom/kokoro",
}
# Sidecars of the retired sidecar browser handoff, deleted with no consumer left.
RETIRED_SIDECARS = ("browser-broker", "rest-lock-proxy", "tcp-proxy")

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
        self.assertEqual(set(packages), set(PUBLIC_PACKAGES))
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
        for name in PUBLIC_PACKAGES:
            dockerfile = ROOT / "sidecars" / name / "Dockerfile"
            with self.subTest(name=name):
                text = dockerfile.read_text(encoding="utf-8")
                self.assertIn("org.opencontainers.image.source=\"https://github.com/switchroom/switchroom\"", text)
                self.assertIn(f"org.opencontainers.image.title=\"hermes-fleet-{name}\"", text)
                self.assertNotIn("hermes-fleet-private", text)
                self.assertNotIn("KEN-", text)


class SidecarImageRefTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ref = load(IMAGE_REF, "sidecar_image_ref")

    def test_accepts_digest_pin_for_allowed_public_package(self) -> None:
        value = f"ghcr.io/switchroom/kokoro@sha256:{DIGEST}"
        self.assertEqual(self.ref.require_sidecar_image(value), value)

    def test_accepts_digest_pin_for_legacy_package_name(self) -> None:
        value = f"ghcr.io/mekenthompson/hermes-fleet-kokoro@sha256:{DIGEST}"
        self.assertEqual(self.ref.require_sidecar_image(value), value)

    def test_rejects_mutable_tag(self) -> None:
        with self.assertRaises(ValueError):
            self.ref.require_sidecar_image(
                "ghcr.io/switchroom/kokoro:latest"
            )

    def test_rejects_unprefixed_private_package_even_with_digest(self) -> None:
        with self.assertRaises(ValueError):
            self.ref.require_sidecar_image(
                f"ghcr.io/mekenthompson/hermes-kokoro@sha256:{DIGEST}"
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
            "sidecars/kokoro/Dockerfile",
            "sidecars/kokoro/server.py",
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
        mapping = {name: ROOT / f".github/workflows/sidecar-{name}.yml" for name in PUBLIC_PACKAGES}
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
        mapping = {name: ROOT / f".github/workflows/sidecar-{name}.yml" for name in PUBLIC_PACKAGES}
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

    def test_docs_drop_the_camofox_sidecar(self) -> None:
        docs = (ROOT / "docs/sidecars.md").read_text(encoding="utf-8")
        self.assertNotIn("ghcr.io/switchroom/camofox", docs)
        self.assertNotIn("sidecars/camofox", docs)


class HandoffSidecarsRetiredTests(unittest.TestCase):
    """The browser broker, REST lock proxy and TCP/noVNC proxy served only the retired sidecar handoff.

    Their source, workflows and standalone example are gone. Published digests stay in GHCR;
    nothing here deletes or retags them.
    """

    def test_no_source_workflow_package_or_example(self) -> None:
        packages = json.loads(CONTRACT.read_text(encoding="utf-8"))["packages"]
        self.assertFalse((ROOT / "examples/compose.sidecars.example.yaml").exists())
        for name in RETIRED_SIDECARS:
            with self.subTest(name=name):
                self.assertFalse((ROOT / "sidecars" / name).exists())
                self.assertFalse((ROOT / f".github/workflows/sidecar-{name}.yml").exists())
                self.assertNotIn(name, packages)

    def test_sidecar_refs_no_longer_accept_them(self) -> None:
        ref = load(IMAGE_REF, "sidecar_image_ref_handoff_retired")
        for name in RETIRED_SIDECARS:
            for repository in (f"ghcr.io/switchroom/{name}", f"ghcr.io/mekenthompson/hermes-fleet-{name}"):
                with self.subTest(repository=repository), self.assertRaises(ValueError):
                    ref.require_sidecar_image(f"{repository}@sha256:{DIGEST}")

    def test_docs_list_only_live_sidecar_images(self) -> None:
        docs = (ROOT / "docs/sidecars.md").read_text(encoding="utf-8")
        for name in RETIRED_SIDECARS:
            with self.subTest(name=name):
                self.assertNotIn(f"ghcr.io/switchroom/{name}", docs)


if __name__ == "__main__":
    unittest.main()
