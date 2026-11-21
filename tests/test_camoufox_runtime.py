"""The image's Camoufox stack (HF-773): pins, the downstream patch, the service, the bake smoke.

These are source checks. The headed proof is scripts/verify-camoufox-runtime.py, which the Fleet
Image workflow runs in the candidate image (UID 1000, fleet seccomp, no-new-privileges).
"""
from __future__ import annotations

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "release" / "camoufox.lock.json").read_text(encoding="utf-8"))
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "fleet-image.yml").read_text(encoding="utf-8")
SERVICE = (ROOT / "docker" / "camofox-browser" / "service-run").read_text(encoding="utf-8")
PATCH = (ROOT / "release" / "camofox-browser" / "official-camoufox.patch").read_text(encoding="utf-8")


class LockTests(unittest.TestCase):
    def test_camoufox_is_the_attested_latest_stable_build(self):
        c = LOCK["camoufox"]
        self.assertEqual((c["version"], c["build"]), ("158.0.1", "beta.41"))
        self.assertEqual(c["tag"], f"v{c['version']}-{c['build']}")
        self.assertEqual(c["asset"], f"camoufox-{c['version']}-{c['build']}-lin.x86_64.zip")
        self.assertRegex(c["sha256"], r"^[0-9a-f]{64}$")
        self.assertGreater(c["size"], 10**9)
        self.assertIs(c["attestation"]["required"], True)
        self.assertEqual(c["attestation"]["signer_workflow"], "daijro/camoufox/.github/workflows/release.yml")
        self.assertEqual(c["install_dir"], "/opt/camoufox")
        self.assertEqual(c["executable"], "/opt/camoufox/camoufox-bin")

    def test_camofox_browser_is_the_integrity_pinned_npm_tarball(self):
        s = LOCK["camofox_browser"]
        self.assertEqual((s["package"], s["version"]), ("@askjo/camofox-browser", "1.19.0"))
        self.assertTrue(s["tarball"].startswith("https://registry.npmjs.org/@askjo/camofox-browser/-/"))
        self.assertRegex(s["integrity"], r"^sha512-[A-Za-z0-9+/]{86}==$")
        (patch,) = s["patches"]
        self.assertEqual(patch["id"], "official-camoufox")
        self.assertTrue((ROOT / patch["file"]).is_file())
        self.assertIn("jo-inc/camofox-browser", patch["upstream"])

    def test_npm_lock_resolves_the_official_package_only(self):
        lock = json.loads((ROOT / LOCK["camofox_browser"]["npm_lock"]).read_text(encoding="utf-8"))
        packages = lock["packages"]
        self.assertEqual(packages[""]["version"], "1.19.0")
        self.assertEqual(packages[""]["dependencies"]["camoufox"], "0.5.9")
        self.assertNotIn("camoufox-js", packages[""]["dependencies"])
        self.assertNotIn("node_modules/camoufox-js", packages)
        self.assertEqual(packages["node_modules/camoufox"]["version"], "0.5.9")
        major, minor, _ = (int(p) for p in packages["node_modules/playwright-core"]["version"].split("."))
        self.assertLess((major, minor), (1, 63))
        for name, meta in packages.items():
            if name and not meta.get("link"):
                with self.subTest(package=name):
                    self.assertTrue(meta.get("integrity", "").startswith("sha512-"), name)
                    self.assertTrue(meta.get("resolved", "").startswith("https://registry.npmjs.org/"), name)


class PatchTests(unittest.TestCase):
    def test_patch_swaps_camoufox_js_for_the_official_package_and_bumps_the_pin(self):
        files = re.findall(r"^diff -ruN a/(\S+) b/", PATCH, re.M)
        self.assertEqual(sorted(files), ["lib/camoufox-download.js", "lib/camoufox-executable.js",
                                         "package.json", "server.js"])
        added = "\n".join(line for line in PATCH.splitlines() if line.startswith("+") and not line.startswith("+++"))
        self.assertNotIn("camoufox-js", added.replace("camoufox-js@", ""))
        self.assertIn("import { Camoufox, launchOptions, VirtualDisplay } from 'camoufox';", added)
        self.assertIn("BUNDLED_CAMOUFOX_RELEASE = '158.0.1-beta.41'", added)
        self.assertIn('"camoufox": "0.5.9"', added)
        self.assertNotRegex(PATCH, r"^(---|\+\+\+) \S+\t", "patch headers must not carry timestamps")


class ImageTests(unittest.TestCase):
    def test_dockerfile_installs_desktop_browsers_and_camoufox(self):
        for token in (
            "tigervnc-standalone-server", "xfce4-panel", "chromium", "adwaita-icon-theme-legacy",
            "libdbus-glib-1-2", "libegl1", "fonts-noto-core", "fonts-noto-color-emoji", "locales",
            "en_AU.UTF-8 UTF-8", "LANG=en_AU.UTF-8", "BH_TAB_MARKER=0",
            "COPY release/camoufox.lock.json /opt/hermes-fleet/release/camoufox.lock.json",
            "gh attestation verify", "--signer-workflow", "unzip -q \"$archive\" -d /opt/camoufox",
            "/opt/camoufox/.hermes-fleet-provenance.json", "/usr/share/icons/hicolor/${size}x${size}/apps/camoufox.png",
            "git apply --whitespace=nowarn /tmp/camofox-browser-release/official-camoufox.patch",
            "npm ci --omit=dev --ignore-scripts", "test ! -e node_modules/camoufox-js",
            "COPY docker/s6-rc.d/camofox-browser/ /etc/s6-overlay/s6-rc.d/camofox-browser/",
            "COPY docker/s6-rc.d/user/contents.d/camofox-browser",
            "CAMOFOX_URL=http://127.0.0.1:9377", "S6_SERVICES_GRACETIME=50000",
            "COPY --chmod=0755 scripts/verify-camoufox-runtime.py /opt/hermes-fleet/bin/verify-camoufox-runtime.py",
        ):
            with self.subTest(token=token):
                self.assertIn(token, DOCKERFILE)
        # Camoufox is never registered with the per-profile tool store.
        self.assertNotIn("/opt/hermes/tools/camoufox", DOCKERFILE)
        # The plugins are mounted by deployment, never baked.
        self.assertNotIn("COPY plugins/camofox", DOCKERFILE)
        self.assertNotIn("COPY plugins/camoufox-desktop", DOCKERFILE)

    def test_s6_service_is_a_supervised_longrun_without_root(self):
        svc = ROOT / "docker" / "s6-rc.d" / "camofox-browser"
        self.assertEqual((svc / "type").read_text().strip(), "longrun")
        self.assertTrue((svc / "dependencies.d" / "base").is_file())
        self.assertTrue((ROOT / "docker" / "s6-rc.d" / "user" / "contents.d" / "camofox-browser").is_file())
        run = (svc / "run").read_text()
        self.assertIn('[ "$(id -u)" = 0 ] || exec /usr/local/lib/camofox-browser/service-run', run)

    def test_service_is_loopback_keyed_headed_quiet_and_persistent(self):
        for token in (
            "export CAMOFOX_BIND_HOST=127.0.0.1",
            'export CAMOFOX_ACCESS_KEY="$access_key" CAMOFOX_API_KEY="$access_key"',
            "export CAMOFOX_INTERACTIVE=desktop",
            "export CAMOFOX_CRASH_REPORT_ENABLED=false SENTRY_DSN= PROMETHEUS_ENABLED=false",
            "CAMOFOX_DISABLE_DEFAULT_ADDONS=${CAMOFOX_DISABLE_DEFAULT_ADDONS:-1}",
            'state=${CAMOFOX_STATE_DIR:-$home_dir/camofox-browser}',
            'export CAMOFOX_PROFILE_DIR="$state/profiles"',
            "SESSION_TIMEOUT_MS=${SESSION_TIMEOUT_MS:-0}",
            "TAB_INACTIVITY_MS=${TAB_INACTIVITY_MS:-28800000}",
            "trap stop TERM INT",
            'kill -TERM "$child"',
            "unset ENABLE_VNC",
        ):
            with self.subTest(token=token):
                self.assertIn(token, SERVICE)
        self.assertIn("umask 077", SERVICE)
        self.assertNotIn("0.0.0.0", SERVICE)

    def test_both_bake_jobs_run_the_headed_smoke_under_the_runtime_sandbox(self):
        self.assertEqual(WORKFLOW.count("/opt/hermes-fleet/bin/verify-camoufox-runtime.py --out /smoke"), 2)
        for token in ("--user 1000:1000", "--security-opt no-new-privileges",
                      "--security-opt seccomp=security/chromium-seccomp.json", "--network none"):
            with self.subTest(token=token):
                self.assertGreaterEqual(WORKFLOW.count(token), 2)
        self.assertEqual(WORKFLOW.count("name: camoufox-smoke-${{ github.sha }}-${{ github.job }}"), 2)


class VendoredPluginTests(unittest.TestCase):
    PLUGIN = ROOT / "plugins" / "camofox"

    def test_official_camofox_plugin_is_vendored_unmodified(self):
        upstream = json.loads((self.PLUGIN / "UPSTREAM.json").read_text(encoding="utf-8"))
        self.assertEqual(upstream["repository"], "https://github.com/NousResearch/hermes-official-plugins.git")
        self.assertRegex(upstream["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(upstream["version"], "1.2.0")
        self.assertEqual(upstream["patches"], [])
        on_disk = sorted(p.name for p in self.PLUGIN.iterdir() if p.is_file())
        self.assertEqual(on_disk, sorted([*upstream["files_sha256"], "UPSTREAM.json"]))
        for name, digest in upstream["files_sha256"].items():
            with self.subTest(file=name):
                self.assertEqual(hashlib.sha256((self.PLUGIN / name).read_bytes()).hexdigest(), digest)
        self.assertIn("version: 1.2.0", (self.PLUGIN / "plugin.yaml").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
